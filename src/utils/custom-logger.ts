// workers ignore environment.ts/environment.prod.ts replacement done by angular
// so use this instead
// add NG_APP_ENV to your env in production server
const isProd = import.meta.env['NG_APP_ENV'] === 'production';

export const customLogger = {
  log:   isProd ? () => {} : console.log.bind(console),
  debug: isProd ? () => {} : console.debug.bind(console),
  warn:  isProd ? () => {} : console.warn.bind(console),
  info:  isProd ? () => {} : console.info.bind(console),
  error: console.error.bind(console),
};