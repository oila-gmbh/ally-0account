import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { HttpContext } from '@adonisjs/core/http'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { test } from '@japa/runner'

import { ZeroAccountDriver, type ZeroAccountConfig } from '../src/driver.js'

const driverConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackUrl: 'http://localhost:3333/callback',
} satisfies ZeroAccountConfig

function createContext(
  options: { qs?: Record<string, string>; cookies?: Record<string, string> } = {}
) {
  const ctx = new HttpContextFactory().create()
  const cookies: Record<string, string> = { ...options.cookies }
  ctx.request.updateQs(options.qs || {})
  ctx.request.encryptedCookie = (key: string) => cookies[key]
  ctx.response.encryptedCookie = ((key: string, value: string) => {
    cookies[key] = value
    return ctx.response
  }) as typeof ctx.response.encryptedCookie
  ctx.response.clearCookie = ((key: string) => {
    delete cookies[key]
    return ctx.response
  }) as typeof ctx.response.clearCookie
  return { ctx, cookies }
}

function createDriver(ctx: HttpContext, config: Partial<ZeroAccountConfig> = {}) {
  return new ZeroAccountDriver(ctx, { ...driverConfig, ...config })
}

function createCallbackContext() {
  return createContext({
    qs: { code: 'auth-code', state: 'issued-state' },
    cookies: {
      zeroaccount_oauth_state: 'issued-state',
      zeroaccount_code_verifier: 'issued-verifier',
    },
  })
}

function redirectLocation(ctx: HttpContext): URL {
  const location = ctx.response.getHeader('location')
  if (!location) {
    throw new Error('Redirect response did not set a location header')
  }
  return new URL(String(location))
}

test.group('ZeroAccountDriver | redirect', () => {
  test('redirects to the authorize endpoint with code flow, default scopes and PKCE', async ({
    assert,
  }) => {
    const { ctx, cookies } = createContext()

    await createDriver(ctx).redirect()

    const location = redirectLocation(ctx)
    assert.equal(location.origin + location.pathname, 'https://v1.0account.com/oauth/authorize')
    assert.equal(location.searchParams.get('response_type'), 'code')
    assert.equal(location.searchParams.get('client_id'), 'client-id')
    assert.equal(location.searchParams.get('redirect_uri'), driverConfig.callbackUrl)
    assert.equal(location.searchParams.get('scope'), 'openid profile email')
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.match(location.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/)
    assert.match(cookies.zeroaccount_code_verifier, /^[A-Za-z0-9_-]{64}$/)
    assert.equal(cookies.zeroaccount_oauth_state, location.searchParams.get('state'))
  })

  test('derives the code challenge from the stored verifier', async ({ assert }) => {
    const { ctx, cookies } = createContext()

    await createDriver(ctx).redirect()

    const expectedChallenge = createHash('sha256')
      .update(cookies.zeroaccount_code_verifier)
      .digest('base64url')
    assert.equal(redirectLocation(ctx).searchParams.get('code_challenge'), expectedChallenge)
  })

  test('honours configured scopes and authorize url override', async ({ assert }) => {
    const { ctx } = createContext()
    const driver = new ZeroAccountDriver(ctx, {
      ...driverConfig,
      scopes: ['openid', 'offline_access'],
      authorizeUrl: 'https://id.example.com/oauth/authorize',
    })

    await driver.redirect()

    const location = redirectLocation(ctx)
    assert.equal(location.origin + location.pathname, 'https://id.example.com/oauth/authorize')
    assert.equal(location.searchParams.get('scope'), 'openid offline_access')
  })
})

test.group('ZeroAccountDriver | access token', () => {
  test('exchanges the code with the stored PKCE verifier and maps the token response', async ({
    assert,
  }) => {
    const { ctx, cookies } = createCallbackContext()

    let receivedBody = ''
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        receivedBody = body
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            access_token: 'the-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile email',
            id_token: 'the-id-token',
            refresh_token: 'the-refresh-token',
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as AddressInfo
      const token = await createDriver(ctx, {
        accessTokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      }).accessToken()

      const form = new URLSearchParams(receivedBody)
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(form.get('code'), 'auth-code')
      assert.equal(form.get('code_verifier'), 'issued-verifier')
      assert.equal(form.get('client_id'), 'client-id')
      assert.equal(form.get('client_secret'), 'client-secret')
      assert.equal(form.get('redirect_uri'), driverConfig.callbackUrl)

      assert.equal(token.token, 'the-access-token')
      assert.equal(token.type, 'Bearer')
      assert.equal(token.expiresIn, 3600)
      assert.equal(token.scope, 'openid profile email')
      assert.equal(token.idToken, 'the-id-token')
      assert.equal(token.refreshToken, 'the-refresh-token')
      assert.instanceOf(token.expiresAt, Date)
      assert.notEqual(cookies.zeroaccount_code_verifier, 'issued-verifier')
    } finally {
      server.close()
    }
  })
})

test.group('ZeroAccountDriver | accessDenied', () => {
  test('reports denial for access_denied and login_required errors', ({ assert }) => {
    for (const error of ['access_denied', 'login_required']) {
      const { ctx } = createContext({ qs: { error } })
      assert.isTrue(createDriver(ctx).accessDenied())
    }
  })

  test('ignores other errors', ({ assert }) => {
    const { ctx } = createContext({ qs: { error: 'invalid_request' } })
    assert.isFalse(createDriver(ctx).accessDenied())

    const noError = createContext()
    assert.isFalse(createDriver(noError.ctx).accessDenied())
  })
})

test.group('ZeroAccountDriver | user', () => {
  const userinfo = {
    'sub': 'pairwise-sub-1',
    'iss': 'https://v1.0account.com',
    'aud': 'client-id',
    'given_name': 'Ada',
    'family_name': 'Lovelace',
    'email': 'ada@example.com',
    'email_verified': true,
    'picture': 'https://img.0account.com/ada.png',
    'https://0account.com/claims/fields': { loyalty_card: 'x-1' },
  }

  function startOidcServer(userInfoBody: object) {
    const received: { path?: string; authorization?: string; tokenBody?: string } = {}
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.path = req.url
        received.authorization = req.headers.authorization
        received.tokenBody = body
        res.setHeader('content-type', 'application/json')
        if (req.url === '/oauth/token') {
          res.end(JSON.stringify({ access_token: 'the-access-token', token_type: 'Bearer' }))
          return
        }
        res.end(JSON.stringify(userInfoBody))
      })
    })
    return { server, received }
  }

  test('fetches the user with the access token and maps the userinfo claims', async ({
    assert,
  }) => {
    const { ctx, cookies } = createCallbackContext()
    const { server, received } = startOidcServer(userinfo)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as AddressInfo
      const user = await createDriver(ctx, {
        accessTokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        userInfoUrl: `http://127.0.0.1:${port}/oauth/userinfo`,
      }).user()

      assert.equal(received.path, '/oauth/userinfo')
      assert.equal(received.authorization, 'Bearer the-access-token')

      assert.equal(user.id, 'pairwise-sub-1')
      assert.equal(user.name, 'Ada Lovelace')
      assert.equal(user.nickName, 'Ada Lovelace')
      assert.equal(user.email, 'ada@example.com')
      assert.equal(user.emailVerificationState, 'verified')
      assert.equal(user.avatarUrl, 'https://img.0account.com/ada.png')
      assert.deepEqual(user.original, userinfo)

      assert.equal(user.token.token, 'the-access-token')
      assert.equal(user.token.type, 'Bearer')
      assert.isUndefined(user.token.idToken)
      assert.isUndefined(cookies.zeroaccount_code_verifier)
    } finally {
      server.close()
    }
  })

  test('reports an unverified email as unverified', async ({ assert }) => {
    const { ctx } = createCallbackContext()
    const { server } = startOidcServer({
      sub: 'sub-2',
      given_name: 'Grace',
      email: 'grace@example.com',
      email_verified: false,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as AddressInfo
      const user = await createDriver(ctx, {
        accessTokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        userInfoUrl: `http://127.0.0.1:${port}/oauth/userinfo`,
      }).user()

      assert.equal(user.name, 'Grace')
      assert.equal(user.email, 'grace@example.com')
      assert.equal(user.emailVerificationState, 'unverified')
    } finally {
      server.close()
    }
  })

  test('reports a missing email as unsupported', async ({ assert }) => {
    const { ctx } = createCallbackContext()
    const { server } = startOidcServer({
      sub: 'sub-3',
      family_name: 'Hopper',
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as AddressInfo
      const user = await createDriver(ctx, {
        accessTokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        userInfoUrl: `http://127.0.0.1:${port}/oauth/userinfo`,
      }).user()

      assert.equal(user.name, 'Hopper')
      assert.isNull(user.email)
      assert.equal(user.emailVerificationState, 'unsupported')
    } finally {
      server.close()
    }
  })

  test('finds the user from an access token without exchanging the code', async ({ assert }) => {
    const { server, received } = startOidcServer(userinfo)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as AddressInfo
      const user = await createDriver(new HttpContextFactory().create(), {
        userInfoUrl: `http://127.0.0.1:${port}/oauth/userinfo`,
      }).userFromToken('raw-token')

      assert.equal(received.authorization, 'Bearer raw-token')
      assert.equal(user.id, 'pairwise-sub-1')
      assert.deepEqual(user.token, { token: 'raw-token', type: 'bearer' })
    } finally {
      server.close()
    }
  })
})
