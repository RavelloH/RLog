const Rlog = require('./index.js')
const rlog = new Rlog({
  logFilePath: './log.txt',
  timezone: 'Asia/Shanghai',
  matchingRules: ['world', '[0-9]{9}'],
});

// rlog.config.logFilePath = './log.txt'
// rlog.config.timezone = 'Asia/Shanghai'
// rlog.config.matchingRules = ['world', '[0-9]{9}']


rlog.info('ok1')
rlog.info(123456789)
rlog.info(true)
rlog.info({
  time: Date.now(),
  text: 'example'
})
rlog.info([1, 2, '5'])
rlog.info(`hello world !! 123456789`)
rlog.warning('This is a warning')
rlog.success('This is a success')
rlog.info('Welcome to https://github.com')
rlog.info('my ip is 123.45.67.89')
rlog.info('1970-12-12')
rlog.info('false true')
rlog.info('my email\nasd\nasd\nasdsdsad\nasd\nis example@site.com')
rlog.error('ok4')

/* console.time()

for (i=0;i<=1000;i++) {
    rlog.info(i)
}

console.timeEnd() */