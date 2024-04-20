import { config } from '/config.js'

var connQuotaBlock = new algo.Quota(
  Number.parseInt(config.limits.conn.rate / __thread.concurrency),
  { per: 1 }
)
var brokerCapacities = config.brokers.reduce(function (caps, i) { //TODO dynamically!!!
  caps = caps + Number.parseInt(i.capicity)
  return caps
}, 0)
var connRate = Number.parseInt(config.limits.conn.rate)
var connQuota = new algo.Quota((connRate < brokerCapacities ? connRate : brokerCapacities) / __thread.concurrency)
var $ctx
export default pipeline($ => $
  .onStart(
    function (ctx) {
      $ctx = ctx
    }
  )
  .demux().to($ => $
    .pipe(
      function (event) {
        if (event instanceof MessageStart) {
          var type = event?.head?.type
          switch (type) {
            case 'CONNECT':
              if (config.limits.conn.fastFail === 'true') {
                if (connQuota.consume(1) !== 1) {
                  return connFastFail
                }
                //record to release when disconnecting in main pipeline
                $ctx.connQuota = connQuota
                return bypass
              }
              return connThrottle
            case 'PUBLISH':
              return pubThrottle
            default: return bypass
          }
        }
        return bypass
      })
  )
)

var connThrottle = pipeline($ => $
  .throttleMessageRate(connQuotaBlock, { blockInput: config.limits.conn.blockInput })
  .pipe(() => bypass)
)

var pubThrottle = pipeline($ => $
  .throttleMessageRate(
    new algo.Quota(Number.parseInt(config.limits.pub.rate / __thread.concurrency), { per: 1 }),
    { blockInput: config.limits.conn.blockInput })
  .pipe(() => bypass)
)

var connFastFail = pipeline($ => $
  .replaceMessage(
    [new Message({ type: 'CONNACK', reasonCode: 159, sessionPresent: false }, 'Connection rate exceeded'), new StreamEnd]
  )
  .fork().to($ => $.swap(() => $ctx.down))
)

var bypass = pipeline($ => $
  .mux(() => $ctx).to($ => $
    .fork().to($ => $.pipeNext())
  ))