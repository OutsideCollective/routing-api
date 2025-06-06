import Joi from '@hapi/joi'
import { Protocol } from '@uniswap/router-sdk'
import { ChainId, Currency, CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core'
import {
  AlphaRouterConfig,
  getAddress,
  ID_TO_NETWORK_NAME,
  IMetric,
  IRouter,
  MetricLoggerUnit,
  routeAmountsToString,
  SimulationStatus,
  sortsBefore,
  SwapOptions,
  SwapRoute,
  V4_ETH_WETH_FAKE_POOL,
} from '@uniswap/smart-order-router'
import { Pool as V3Pool } from '@uniswap/v3-sdk'
import { Pool as V4Pool } from '@uniswap/v4-sdk'
import JSBI from 'jsbi'
import _ from 'lodash'
import { APIGLambdaHandler, ErrorResponse, HandleRequestParams, Response } from '../handler'
import { ContainerInjected, RequestInjected } from '../injector-sor'
import { QuoteResponse, QuoteResponseSchemaJoi, SupportedPoolInRoute } from '../schema'
import {
  DEFAULT_ROUTING_CONFIG_BY_CHAIN,
  FEE_ON_TRANSFER_SPECIFIC_CONFIG,
  INTENT_SPECIFIC_CONFIG,
  QUOTE_SPEED_CONFIG,
} from '../shared'
import { QuoteQueryParams, QuoteQueryParamsJoi, TradeTypeParam } from './schema/quote-schema'
import { simulationStatusTranslation } from './util/simulation'
import Logger from 'bunyan'
import { PAIRS_TO_TRACK } from './util/pairs-to-track'
import { measureDistributionPercentChangeImpact } from '../../util/alpha-config-measurement'
import { MetricsLogger } from 'aws-embedded-metrics'
import { CurrencyLookup } from '../CurrencyLookup'
import { SwapOptionsFactory } from './SwapOptionsFactory'
import { GlobalRpcProviders } from '../../rpc/GlobalRpcProviders'
import { adhocCorrectGasUsed } from '../../util/estimateGasUsed'
import { adhocCorrectGasUsedUSD } from '../../util/estimateGasUsedUSD'
import { Pair } from '@uniswap/v2-sdk'
import { UniversalRouterVersion } from '@uniswap/universal-router-sdk'
import {
  convertStringRouterVersionToEnum,
  protocolVersionsToBeExcludedFromMixed,
  URVersionsToProtocolVersions,
} from '../../util/supportedProtocolVersions'
import { enableMixedRouteEthWeth } from '../../util/enableMixedRouteEthWeth'

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected<IRouter<AlphaRouterConfig>>,
  void,
  QuoteQueryParams,
  QuoteResponse
> {
  public async handleRequest(
    params: HandleRequestParams<ContainerInjected, RequestInjected<IRouter<any>>, void, QuoteQueryParams>
  ): Promise<Response<QuoteResponse> | ErrorResponse> {
    const { chainId, metric, log, quoteSpeed, intent } = params.requestInjected

    // Mark the start of core business logic for latency bookkeeping.
    // Note that some time may have elapsed before handleRequest was called, so this
    // time does not accurately indicate when our lambda started processing the request,
    // resulting in slightly underreported metrics.
    //
    // To use the true requestStartTime, the route APIGLambdaHandler needs to be
    // refactored to call handleRequest with the startTime.
    const startTime = Date.now()

    let result: Response<QuoteResponse> | ErrorResponse
    const useRpcGateway = GlobalRpcProviders.getGlobalUniRpcProviders(log).has(chainId)

    try {
      if (useRpcGateway) {
        const provider = GlobalRpcProviders.getGlobalUniRpcProviders(log).get(chainId)!
        provider.forceAttachToNewSession()
        provider.shouldEvaluate = true
      }

      result = await this.handleRequestInternal(params, startTime)

      switch (result.statusCode) {
        case 200:
        case 202:
          metric.putMetric(`GET_QUOTE_200_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
          metric.putMetric(
            `GET_QUOTE_200_REQUEST_SOURCE: ${params.requestQueryParams.source}`,
            1,
            MetricLoggerUnit.Count
          )
          metric.putMetric(
            `GET_QUOTE_200_REQUEST_SOURCE_AND_CHAINID: ${params.requestQueryParams.source} ${chainId}`,
            1,
            MetricLoggerUnit.Count
          )
          break
        case 400:
        case 403:
        case 404:
        case 408:
        case 409:
          metric.putMetric(`GET_QUOTE_400_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
          metric.putMetric(
            `GET_QUOTE_400_REQUEST_SOURCE: ${params.requestQueryParams.source}`,
            1,
            MetricLoggerUnit.Count
          )
          metric.putMetric(
            `GET_QUOTE_400_REQUEST_SOURCE_AND_CHAINID: ${params.requestQueryParams.source} ${chainId}`,
            1,
            MetricLoggerUnit.Count
          )
          log.error(
            {
              statusCode: result?.statusCode,
              errorCode: result?.errorCode,
              detail: result?.detail,
            },
            `Quote 4XX Error [${result?.statusCode}] on ${ID_TO_NETWORK_NAME(chainId)} with errorCode '${
              result?.errorCode
            }': ${result?.detail}`
          )
          break
        case 500:
          metric.putMetric(`GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
          if (useRpcGateway) {
            metric.putMetric(`RPC_GATEWAY_GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
          }
          metric.putMetric(
            `GET_QUOTE_500_REQUEST_SOURCE: ${params.requestQueryParams.source}`,
            1,
            MetricLoggerUnit.Count
          )
          metric.putMetric(
            `GET_QUOTE_500_REQUEST_SOURCE_AND_CHAINID: ${params.requestQueryParams.source} ${chainId}`,
            1,
            MetricLoggerUnit.Count
          )
          log.error(
            {
              statusCode: result?.statusCode,
              errorCode: result?.errorCode,
              detail: result?.detail,
            },
            `Quote 5XX Error [${result?.statusCode}] on ${ID_TO_NETWORK_NAME(chainId)} with errorCode '${
              result?.errorCode
            }': ${result?.detail}`
          )
          break
      }
    } catch (err) {
      metric.putMetric(`GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
      if (useRpcGateway) {
        metric.putMetric(`RPC_GATEWAY_GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
      }
      metric.putMetric(`GET_QUOTE_500_REQUEST_SOURCE: ${params.requestQueryParams.source}`, 1, MetricLoggerUnit.Count)
      metric.putMetric(
        `GET_QUOTE_500_REQUEST_SOURCE_AND_CHAINID: ${params.requestQueryParams.source} ${chainId}`,
        1,
        MetricLoggerUnit.Count
      )

      log.error(`Quote 5XX Error on ${ID_TO_NETWORK_NAME(chainId)} with exception '${err}'`)

      throw err
    } finally {
      // This metric is logged after calling the internal handler to correlate with the status metrics
      metric.putMetric(`GET_QUOTE_REQUEST_SOURCE: ${params.requestQueryParams.source}`, 1, MetricLoggerUnit.Count)
      metric.putMetric(`GET_QUOTE_REQUESTED_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
      if (useRpcGateway) {
        metric.putMetric(`RPC_GATEWAY_GET_QUOTE_REQUESTED_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count)
      }
      metric.putMetric(
        `GET_QUOTE_REQUEST_SOURCE_AND_CHAINID: ${params.requestQueryParams.source} ${chainId}`,
        1,
        MetricLoggerUnit.Count
      )

      metric.putMetric(`GET_QUOTE_LATENCY_CHAIN_${chainId}`, Date.now() - startTime, MetricLoggerUnit.Milliseconds)
      if (useRpcGateway) {
        metric.putMetric(
          `RPC_GATEWAY_GET_QUOTE_LATENCY_CHAIN_${chainId}`,
          Date.now() - startTime,
          MetricLoggerUnit.Milliseconds
        )
      }

      metric.putMetric(
        `GET_QUOTE_LATENCY_CHAIN_${chainId}_QUOTE_SPEED_${quoteSpeed ?? 'standard'}`,
        Date.now() - startTime,
        MetricLoggerUnit.Milliseconds
      )
      metric.putMetric(
        `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_${intent ?? 'quote'}`,
        Date.now() - startTime,
        MetricLoggerUnit.Milliseconds
      )
    }

    return result
  }

  private async handleRequestInternal(
    params: HandleRequestParams<ContainerInjected, RequestInjected<IRouter<any>>, void, QuoteQueryParams>,
    handleRequestStartTime: number
  ): Promise<Response<QuoteResponse> | ErrorResponse> {
    const {
      requestQueryParams: {
        tokenInAddress,
        tokenInChainId,
        tokenOutAddress,
        tokenOutChainId,
        amount: amountRaw,
        type,
        recipient,
        slippageTolerance,
        deadline,
        minSplits,
        forceCrossProtocol,
        forceMixedRoutes,
        protocols: protocolsStr,
        simulateFromAddress,
        permitSignature,
        permitNonce,
        permitExpiration,
        permitAmount,
        permitSigDeadline,
        enableUniversalRouter,
        quoteSpeed,
        debugRoutingConfig,
        unicornSecret,
        intent,
        enableFeeOnTransferFeeFetching,
        portionBips,
        portionAmount,
        portionRecipient,
        gasToken,
        cachedRoutesRouteIds,
        enableDebug,
        hooksOptions,
      },
      requestInjected: {
        router,
        log,
        id: quoteId,
        chainId,
        tokenProvider,
        tokenListProvider,
        v4PoolProvider: v4PoolProvider,
        v3PoolProvider: v3PoolProvider,
        v2PoolProvider: v2PoolProvider,
        metric,
      },
    } = params
    if (tokenInChainId !== tokenOutChainId) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_CHAINS_DIFFERENT',
        detail: `Cannot request quotes for tokens on different chains`,
      }
    }

    const requestSourceHeader = params.event.headers && params.event.headers['x-request-source']
    const appVersion = params.event.headers && params.event.headers['x-app-version']
    const universalRouterVersion = convertStringRouterVersionToEnum(
      params.event.headers?.['x-universal-router-version']
    )
    const excludedProtocolsFromMixed = protocolVersionsToBeExcludedFromMixed(universalRouterVersion)
    const shouldEnableMixedRouteEthWeth = enableMixedRouteEthWeth(requestSourceHeader)

    if (requestSourceHeader) {
      metric.putMetric(`RequestSource.${requestSourceHeader}`, 1)
    }

    if (appVersion) {
      metric.putMetric(`AppVersion.${appVersion}`, 1)
    }

    const protocols = QuoteHandler.protocolsFromRequest(
      chainId,
      tokenInAddress,
      tokenOutAddress,
      universalRouterVersion,
      protocolsStr,
      forceCrossProtocol
    )

    if (protocols === undefined) {
      return {
        statusCode: 400,
        errorCode: 'INVALID_PROTOCOL',
        detail: `Invalid protocol specified. Supported protocols: ${JSON.stringify(Object.values(Protocol))}`,
      }
    } else if (protocols.length === 1 && protocols[0] === Protocol.MIXED) {
      return {
        statusCode: 400,
        errorCode: 'INVALID_PROTOCOL',
        detail: `Mixed protocol cannot be specified explicitly`,
      }
    }

    // Parse user provided token address/symbol to Currency object.
    const currencyLookupStartTime = Date.now()
    const currencyLookup = new CurrencyLookup(tokenListProvider, tokenProvider, log)
    const [currencyIn, currencyOut] = await Promise.all([
      currencyLookup.searchForToken(tokenInAddress, tokenInChainId),
      currencyLookup.searchForToken(tokenOutAddress, tokenOutChainId),
    ])

    metric.putMetric('TokenInOutStrToToken', Date.now() - currencyLookupStartTime, MetricLoggerUnit.Milliseconds)

    if (!currencyIn) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_IN_INVALID',
        detail: `Could not find token with address "${tokenInAddress}"`,
      }
    }

    if (!currencyOut) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_OUT_INVALID',
        detail: `Could not find token with address "${tokenOutAddress}"`,
      }
    }

    if (currencyIn.wrapped.equals(currencyOut.wrapped)) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_IN_OUT_SAME',
        detail: `tokenIn and tokenOut must be different`,
      }
    }

    let parsedDebugRoutingConfig = {}
    if (debugRoutingConfig && unicornSecret && unicornSecret === process.env.UNICORN_SECRET) {
      parsedDebugRoutingConfig = JSON.parse(debugRoutingConfig)
    }

    const routingConfig: AlphaRouterConfig = {
      ...DEFAULT_ROUTING_CONFIG_BY_CHAIN(chainId),
      ...(minSplits ? { minSplits } : {}),
      ...(forceCrossProtocol ? { forceCrossProtocol } : {}),
      ...(forceMixedRoutes ? { forceMixedRoutes } : {}),
      protocols,
      ...(quoteSpeed ? QUOTE_SPEED_CONFIG[quoteSpeed] : {}),
      ...(intent ? INTENT_SPECIFIC_CONFIG[intent] : {}),
      ...parsedDebugRoutingConfig,
      // Only when enableFeeOnTransferFeeFetching is explicitly set to true, then we
      // override usedCachedRoutes to false. This is to ensure that we don't use
      // accidentally override usedCachedRoutes in the normal path.
      ...(enableFeeOnTransferFeeFetching ? FEE_ON_TRANSFER_SPECIFIC_CONFIG(enableFeeOnTransferFeeFetching) : {}),
      ...(gasToken ? { gasToken } : {}),
      ...(excludedProtocolsFromMixed ? { excludedProtocolsFromMixed } : {}),
      shouldEnableMixedRouteEthWeth: shouldEnableMixedRouteEthWeth,
      ...(cachedRoutesRouteIds ? { cachedRoutesRouteIds } : {}),
      enableMixedRouteWithUR1_2: 100 >= Math.random() * 100, // enable mixed route with UR v1.2 fix at 50%, to see whether we see quote endpoint perf improvement.
      enableDebug: enableDebug,
      hooksOptions: hooksOptions,
    }

    metric.putMetric(`${intent}Intent`, 1, MetricLoggerUnit.Count)

    let swapRoute: SwapRoute | null
    let amount: CurrencyAmount<Currency>

    let tokenPairSymbol = ''
    let tokenPairSymbolChain = ''
    if (currencyIn.symbol && currencyOut.symbol) {
      tokenPairSymbol = _([currencyIn.symbol, currencyOut.symbol]).join('/')
      tokenPairSymbolChain = `${tokenPairSymbol}/${chainId}`
    }

    const [token0Symbol, token0Address, token1Symbol, token1Address] = sortsBefore(currencyIn, currencyOut)
      ? [currencyIn.symbol, getAddress(currencyIn), currencyOut.symbol, getAddress(currencyOut)]
      : [currencyOut.symbol, getAddress(currencyOut), currencyIn.symbol, getAddress(currencyOut)]

    const swapParams: SwapOptions | undefined = SwapOptionsFactory.assemble({
      chainId,
      currencyIn,
      currencyOut,
      tradeType: type,
      universalRouterVersion,
      slippageTolerance,
      enableUniversalRouter,
      portionBips,
      portionRecipient,
      portionAmount,
      amountRaw,
      deadline,
      recipient,
      permitSignature,
      permitNonce,
      permitExpiration,
      permitAmount,
      permitSigDeadline,
      simulateFromAddress,
    })

    if (swapParams?.simulate?.fromAddress) {
      metric.putMetric('Simulation Requested', 1, MetricLoggerUnit.Count)
    }

    switch (type) {
      case 'exactIn':
        amount = CurrencyAmount.fromRawAmount(currencyIn, JSBI.BigInt(amountRaw))

        if (!amount.greaterThan(CurrencyAmount.fromRawAmount(currencyIn, JSBI.BigInt(0)))) {
          return {
            statusCode: 400,
            errorCode: 'AMOUNT_INVALID',
            detail: 'Amount must be greater than 0',
          }
        }

        log.info(
          {
            amountIn: amount.toExact(),
            token0Address,
            token1Address,
            token0Symbol,
            token1Symbol,
            tokenInSymbol: currencyIn.symbol,
            tokenOutSymbol: currencyOut.symbol,
            tokenPairSymbol,
            tokenPairSymbolChain,
            type,
            routingConfig: routingConfig,
            swapParams,
            intent,
            gasToken,
          },
          `Exact In Swap: Give ${amount.toExact()} ${amount.currency.symbol}, Want: ${
            currencyOut.symbol
          }. Chain: ${chainId}`
        )

        swapRoute = await router.route(amount, currencyOut, TradeType.EXACT_INPUT, swapParams, routingConfig)
        break
      case 'exactOut':
        amount = CurrencyAmount.fromRawAmount(currencyOut, JSBI.BigInt(amountRaw))

        if (!amount.greaterThan(CurrencyAmount.fromRawAmount(currencyIn, JSBI.BigInt(0)))) {
          return {
            statusCode: 400,
            errorCode: 'AMOUNT_INVALID',
            detail: 'Amount must be greater than 0',
          }
        }

        log.info(
          {
            amountOut: amount.toExact(),
            token0Address,
            token1Address,
            token0Symbol,
            token1Symbol,
            tokenInSymbol: currencyIn.symbol,
            tokenOutSymbol: currencyOut.symbol,
            tokenPairSymbol,
            tokenPairSymbolChain,
            type,
            routingConfig: routingConfig,
            swapParams,
            gasToken,
          },
          `Exact Out Swap: Want ${amount.toExact()} ${amount.currency.symbol} Give: ${
            currencyIn.symbol
          }. Chain: ${chainId}`
        )

        swapRoute = await router.route(amount, currencyIn, TradeType.EXACT_OUTPUT, swapParams, routingConfig)
        break
      default:
        throw new Error('Invalid swap type')
    }

    if (!swapRoute) {
      log.info(
        {
          type,
          tokenIn: currencyIn,
          tokenOut: currencyOut,
          amount: amount.quotient.toString(),
        },
        `No route found. 404`
      )

      return {
        statusCode: 404,
        errorCode: 'NO_ROUTE',
        detail: 'No route found',
      }
    }

    const {
      quote,
      quoteGasAdjusted,
      quoteGasAndPortionAdjusted,
      route,
      estimatedGasUsed: preProcessedEstimatedGasUsed,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD: preProcessedEstimatedGasUsedUSD,
      estimatedGasUsedGasToken,
      gasPriceWei,
      methodParameters,
      blockNumber,
      simulationStatus,
      hitsCachedRoute,
      portionAmount: outputPortionAmount, // TODO: name it back to portionAmount,
      trade,
    } = swapRoute

    const estimatedGasUsed = adhocCorrectGasUsed(preProcessedEstimatedGasUsed, chainId)
    const estimatedGasUsedUSD = adhocCorrectGasUsedUSD(
      preProcessedEstimatedGasUsed,
      preProcessedEstimatedGasUsedUSD,
      chainId
    )

    if (simulationStatus == SimulationStatus.Failed) {
      metric.putMetric('SimulationFailed', 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.Succeeded) {
      metric.putMetric('SimulationSuccessful', 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.InsufficientBalance) {
      metric.putMetric('SimulationInsufficientBalance', 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.NotApproved) {
      metric.putMetric('SimulationNotApproved', 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.NotSupported) {
      metric.putMetric('SimulationNotSupported', 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.SystemDown) {
      metric.putMetric('SimulationSystemDown', 1, MetricLoggerUnit.Count)
      metric.putMetric(`SimulationSystemDownChainId${chainId}`, 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.SlippageTooLow) {
      metric.putMetric('SlippageTooLow', 1, MetricLoggerUnit.Count)
      metric.putMetric(`SlippageTooLowChainId${chainId}`, 1, MetricLoggerUnit.Count)
    } else if (simulationStatus == SimulationStatus.TransferFromFailed) {
      metric.putMetric('TransferFromFailed', 1, MetricLoggerUnit.Count)
      metric.putMetric(`TransferFromFailedChainId${chainId}`, 1, MetricLoggerUnit.Count)
    }

    const routeResponse: Array<SupportedPoolInRoute[]> = []

    for (const subRoute of route) {
      const { amount, quote, tokenPath } = subRoute

      const pools = subRoute.protocol == Protocol.V2 ? subRoute.route.pairs : subRoute.route.pools
      const curRoute: SupportedPoolInRoute[] = []
      for (let i = 0; i < pools.length; i++) {
        const nextPool = pools[i]
        const tokenIn = tokenPath[i]
        const tokenOut = tokenPath[i + 1]

        let edgeAmountIn = undefined
        if (i == 0) {
          edgeAmountIn = type == 'exactIn' ? amount.quotient.toString() : quote.quotient.toString()
        }

        let edgeAmountOut = undefined
        if (i == pools.length - 1) {
          edgeAmountOut = type == 'exactIn' ? quote.quotient.toString() : amount.quotient.toString()
        }

        if (nextPool instanceof V4Pool) {
          // We want to filter the fake v4 pool here,
          // because in SOR, we intentionally retain the fake pool, when it returns the valid routes
          // https://github.com/Uniswap/smart-order-router/pull/819/files#diff-0eeab2733d13572382be381aa273dddcb38e797adf48c864105fbab2dcf011ffR489
          if (nextPool.tickSpacing === V4_ETH_WETH_FAKE_POOL[chainId].tickSpacing) {
            continue
          }

          curRoute.push({
            type: 'v4-pool',
            address: v4PoolProvider.getPoolId(
              nextPool.token0,
              nextPool.token1,
              nextPool.fee,
              nextPool.tickSpacing,
              nextPool.hooks
            ).poolId,
            tokenIn: {
              chainId: tokenIn.chainId,
              decimals: tokenIn.decimals.toString(),
              address: getAddress(tokenIn),
              symbol: tokenIn.symbol!,
            },
            tokenOut: {
              chainId: tokenOut.chainId,
              decimals: tokenOut.decimals.toString(),
              address: getAddress(tokenOut),
              symbol: tokenOut.symbol!,
            },
            fee: nextPool.fee.toString(),
            tickSpacing: nextPool.tickSpacing.toString(),
            hooks: nextPool.hooks.toString(),
            liquidity: nextPool.liquidity.toString(),
            sqrtRatioX96: nextPool.sqrtRatioX96.toString(),
            tickCurrent: nextPool.tickCurrent.toString(),
            amountIn: edgeAmountIn,
            amountOut: edgeAmountOut,
          })
        } else if (nextPool instanceof V3Pool) {
          curRoute.push({
            type: 'v3-pool',
            address: v3PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1, nextPool.fee).poolAddress,
            tokenIn: {
              chainId: tokenIn.chainId,
              decimals: tokenIn.decimals.toString(),
              address: tokenIn.wrapped.address,
              symbol: tokenIn.symbol!,
            },
            tokenOut: {
              chainId: tokenOut.chainId,
              decimals: tokenOut.decimals.toString(),
              address: tokenOut.wrapped.address,
              symbol: tokenOut.symbol!,
            },
            fee: nextPool.fee.toString(),
            liquidity: nextPool.liquidity.toString(),
            sqrtRatioX96: nextPool.sqrtRatioX96.toString(),
            tickCurrent: nextPool.tickCurrent.toString(),
            amountIn: edgeAmountIn,
            amountOut: edgeAmountOut,
          })
        } else if (nextPool instanceof Pair) {
          const reserve0 = nextPool.reserve0
          const reserve1 = nextPool.reserve1

          curRoute.push({
            type: 'v2-pool',
            address: v2PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1).poolAddress,
            tokenIn: {
              chainId: tokenIn.chainId,
              decimals: tokenIn.decimals.toString(),
              address: tokenIn.wrapped.address,
              symbol: tokenIn.symbol!,
              buyFeeBps: this.deriveBuyFeeBps(tokenIn, reserve0, reserve1, enableFeeOnTransferFeeFetching),
              sellFeeBps: this.deriveSellFeeBps(tokenIn, reserve0, reserve1, enableFeeOnTransferFeeFetching),
            },
            tokenOut: {
              chainId: tokenOut.chainId,
              decimals: tokenOut.decimals.toString(),
              address: tokenOut.wrapped.address,
              symbol: tokenOut.symbol!,
              buyFeeBps: this.deriveBuyFeeBps(tokenOut, reserve0, reserve1, enableFeeOnTransferFeeFetching),
              sellFeeBps: this.deriveSellFeeBps(tokenOut, reserve0, reserve1, enableFeeOnTransferFeeFetching),
            },
            reserve0: {
              token: {
                chainId: reserve0.currency.wrapped.chainId,
                decimals: reserve0.currency.wrapped.decimals.toString(),
                address: reserve0.currency.wrapped.address,
                symbol: reserve0.currency.wrapped.symbol!,
                buyFeeBps: this.deriveBuyFeeBps(
                  reserve0.currency.wrapped,
                  reserve0,
                  undefined,
                  enableFeeOnTransferFeeFetching
                ),
                sellFeeBps: this.deriveSellFeeBps(
                  reserve0.currency.wrapped,
                  reserve0,
                  undefined,
                  enableFeeOnTransferFeeFetching
                ),
              },
              quotient: reserve0.quotient.toString(),
            },
            reserve1: {
              token: {
                chainId: reserve1.currency.wrapped.chainId,
                decimals: reserve1.currency.wrapped.decimals.toString(),
                address: reserve1.currency.wrapped.address,
                symbol: reserve1.currency.wrapped.symbol!,
                buyFeeBps: this.deriveBuyFeeBps(
                  reserve1.currency.wrapped,
                  undefined,
                  reserve1,
                  enableFeeOnTransferFeeFetching
                ),
                sellFeeBps: this.deriveSellFeeBps(
                  reserve1.currency.wrapped,
                  undefined,
                  reserve1,
                  enableFeeOnTransferFeeFetching
                ),
              },
              quotient: reserve1.quotient.toString(),
            },
            amountIn: edgeAmountIn,
            amountOut: edgeAmountOut,
          })
        } else {
          throw new Error(`Unsupported pool type ${JSON.stringify(nextPool)}`)
        }
      }

      routeResponse.push(curRoute)
    }

    const routeString = routeAmountsToString(route)

    const result: QuoteResponse = {
      methodParameters,
      blockNumber: blockNumber.toString(),
      amount: amount.quotient.toString(),
      amountDecimals: amount.toExact(),
      quote: quote.quotient.toString(),
      quoteDecimals: quote.toExact(),
      quoteGasAdjusted: quoteGasAdjusted.quotient.toString(),
      quoteGasAdjustedDecimals: quoteGasAdjusted.toExact(),
      quoteGasAndPortionAdjusted: quoteGasAndPortionAdjusted?.quotient.toString(),
      quoteGasAndPortionAdjustedDecimals: quoteGasAndPortionAdjusted?.toExact(),
      gasUseEstimateQuote: estimatedGasUsedQuoteToken.quotient.toString(),
      gasUseEstimateQuoteDecimals: estimatedGasUsedQuoteToken.toExact(),
      gasUseEstimateGasToken: estimatedGasUsedGasToken?.quotient.toString(),
      gasUseEstimateGasTokenDecimals: estimatedGasUsedGasToken?.toExact(),
      gasUseEstimate: estimatedGasUsed.toString(),
      gasUseEstimateUSD: estimatedGasUsedUSD.toExact(),
      simulationStatus: simulationStatusTranslation(simulationStatus, log),
      simulationError: simulationStatus == SimulationStatus.Failed,
      gasPriceWei: gasPriceWei.toString(),
      route: routeResponse,
      routeString,
      quoteId,
      hitsCachedRoutes: hitsCachedRoute,
      portionBips: outputPortionAmount && portionBips,
      portionRecipient: outputPortionAmount && portionRecipient,
      portionAmount: outputPortionAmount?.quotient.toString(),
      portionAmountDecimals: outputPortionAmount?.toExact(),
      priceImpact: trade?.priceImpact?.toFixed(),
    }

    this.logRouteMetrics(
      log,
      metric,
      handleRequestStartTime,
      currencyIn,
      currencyOut,
      tokenInAddress,
      tokenOutAddress,
      type,
      chainId,
      amount,
      routeString,
      swapRoute
    )

    return {
      statusCode: 200,
      body: result,
    }
  }

  static protocolsFromRequest(
    chainId: ChainId,
    tokenInAddress: string,
    tokenOutAddress: string,
    universalRouterVersion: UniversalRouterVersion,
    requestedProtocols?: string[] | string,
    forceCrossProtocol?: boolean
  ): Protocol[] | undefined {
    const excludeV2 = false

    if (requestedProtocols) {
      let protocols: Protocol[] = []

      // TODO: route-459 - make sure we understand the root cause and revert this tech-debt
      //       we are only doing this because we don't know why cached routes don't refresh in case of all protocols
      if (
        chainId === ChainId.UNICHAIN &&
        ((tokenInAddress.toLowerCase() === '0x9151434b16b9763660705744891fa906f660ecc5' &&
          tokenOutAddress.toLowerCase() === '0x078d782b760474a361dda0af3839290b0ef57ad6') ||
          (tokenInAddress.toLowerCase() === '0x078d782b760474a361dda0af3839290b0ef57ad6' &&
            tokenOutAddress.toLowerCase() === '0x9151434b16b9763660705744891fa906f660ecc5'))
      ) {
        return [Protocol.V4]
      }

      for (const protocolStr of requestedProtocols) {
        switch (protocolStr.toUpperCase()) {
          case Protocol.V2:
            if (chainId === ChainId.MAINNET || !excludeV2) {
              if (URVersionsToProtocolVersions[universalRouterVersion].includes(Protocol.V2)) {
                protocols.push(Protocol.V2)
              }
            }
            break
          case Protocol.V3:
            if (URVersionsToProtocolVersions[universalRouterVersion].includes(Protocol.V3)) {
              protocols.push(Protocol.V3)
            }
            break
          case Protocol.V4:
            if (URVersionsToProtocolVersions[universalRouterVersion].includes(Protocol.V4)) {
              protocols.push(Protocol.V4)
            }
            break
          case Protocol.MIXED:
            if (chainId === ChainId.MAINNET || !excludeV2) {
              protocols.push(Protocol.MIXED)
            }
            break
          default:
            return undefined
        }
      }

      return protocols
    } else if (!forceCrossProtocol) {
      return [Protocol.V3]
    } else {
      return []
    }
  }

  private deriveBuyFeeBps(
    token: Currency,
    reserve0?: CurrencyAmount<Token>,
    reserve1?: CurrencyAmount<Token>,
    enableFeeOnTransferFeeFetching?: boolean
  ): string | undefined {
    if (!enableFeeOnTransferFeeFetching) {
      return undefined
    }

    if (reserve0?.currency.equals(token)) {
      return reserve0.currency.buyFeeBps?.toString()
    }

    if (reserve1?.currency.equals(token)) {
      return reserve1.currency.buyFeeBps?.toString()
    }

    return undefined
  }

  private deriveSellFeeBps(
    token: Currency,
    reserve0?: CurrencyAmount<Token>,
    reserve1?: CurrencyAmount<Token>,
    enableFeeOnTransferFeeFetching?: boolean
  ): string | undefined {
    if (!enableFeeOnTransferFeeFetching) {
      return undefined
    }

    if (reserve0?.currency.equals(token)) {
      return reserve0.currency.sellFeeBps?.toString()
    }

    if (reserve1?.currency.equals(token)) {
      return reserve1.currency.sellFeeBps?.toString()
    }

    return undefined
  }

  private logRouteMetrics(
    log: Logger,
    metric: IMetric,
    handleRequestStartTime: number,
    currencyIn: Currency,
    currencyOut: Currency,
    tokenInAddress: string,
    tokenOutAddress: string,
    tradeType: TradeTypeParam,
    chainId: ChainId,
    amount: CurrencyAmount<Currency>,
    routeString: string,
    swapRoute: SwapRoute
  ): void {
    const tradingPair = `${currencyIn.symbol}/${currencyOut.symbol}`
    const wildcardInPair = `${currencyIn.symbol}/*`
    const wildcardOutPair = `*/${currencyOut.symbol}`
    const tradeTypeEnumValue = tradeType == 'exactIn' ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT
    const pairsTracked = PAIRS_TO_TRACK.get(chainId)?.get(tradeTypeEnumValue)

    measureDistributionPercentChangeImpact(5, 10, swapRoute, currencyIn, currencyOut, tradeType, chainId, amount)

    if (
      pairsTracked?.includes(tradingPair) ||
      pairsTracked?.includes(wildcardInPair) ||
      pairsTracked?.includes(wildcardOutPair)
    ) {
      const metricPair = pairsTracked?.includes(tradingPair)
        ? tradingPair
        : pairsTracked?.includes(wildcardInPair)
        ? wildcardInPair
        : wildcardOutPair

      metric.putMetric(
        `GET_QUOTE_AMOUNT_${metricPair}_${tradeType.toUpperCase()}_CHAIN_${chainId}`,
        Number(amount.toExact()),
        MetricLoggerUnit.None
      )

      metric.putMetric(
        `GET_QUOTE_LATENCY_${metricPair}_${tradeType.toUpperCase()}_CHAIN_${chainId}`,
        Date.now() - handleRequestStartTime,
        MetricLoggerUnit.Milliseconds
      )

      // Create a hashcode from the routeString, this will indicate that a different route is being used
      // hashcode function copied from: https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0?permalink_comment_id=4261728#gistcomment-4261728
      const routeStringHash = Math.abs(
        routeString.split('').reduce((s, c) => (Math.imul(31, s) + c.charCodeAt(0)) | 0, 0)
      )
      // Log the chose route
      log.info(
        {
          tradingPair,
          tokenInAddress,
          tokenOutAddress,
          tradeType,
          amount: amount.toExact(),
          routeString,
          routeStringHash,
          chainId,
        },
        `Tracked Route for pair [${tradingPair}/${tradeType.toUpperCase()}] on chain [${chainId}] with route hash [${routeStringHash}] for amount [${amount.toExact()}]`
      )
    }
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return null
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return QuoteQueryParamsJoi
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return QuoteResponseSchemaJoi
  }

  protected afterHandler(metric: MetricsLogger, response: QuoteResponse, requestStart: number): void {
    metric.putMetric(
      `GET_QUOTE_LATENCY_TOP_LEVEL_${response.hitsCachedRoutes ? 'CACHED_ROUTES_HIT' : 'CACHED_ROUTES_MISS'}`,
      Date.now() - requestStart,
      MetricLoggerUnit.Milliseconds
    )
  }
}
