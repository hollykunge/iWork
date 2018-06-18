import { app, net } from 'electron'

const ErrorEndpoint = 'https://central.github.com/api/desktop/exception'

/** Report the error to Central. */
export async function reportError(
  error: Error,
  extra?: { [key: string]: string }
) {
  if (__DEV__) {
    return
  }

  const data = new Map<string, string>()

  data.set('name', error.name)
  data.set('message', error.message)

  if (error.stack) {
    data.set('stack', error.stack)
  }

  data.set('platform', process.platform)
  data.set('sha', __SHA__)
  data.set('version', app.getVersion())

  if (extra) {
    for (const key of Object.keys(extra)) {
      data.set(key, extra[key])
    }
  }

  const requestOptions: Electron.RequestOptions = {
    method: 'POST',
    url: ErrorEndpoint,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }

  const body = [...data.entries()]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join('&')

  try {
    await new Promise<void>((resolve, reject) => {
      const request = net.request(requestOptions)

      request.on('response', response => {
        if (response.statusCode === 200) {
          resolve()
        } else {
          reject(
            `Got ${response.statusCode} - ${
              response.statusMessage
            } from central`
          )
        }
      })

      request.on('error', reject)

      request.end(body)
    })
    log.info('Error report submitted')
  } catch (e) {
    log.error('Failed submitting error report', error)
  }
}
