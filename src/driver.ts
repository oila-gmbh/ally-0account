import { createHash, randomBytes } from 'node:crypto'

import { Oauth2Driver } from '@adonisjs/ally'
import type { HttpContext } from '@adonisjs/core/http'
import type {
  AllyDriverContract,
  AllyUserContract,
  ApiRequestContract,
  Oauth2AccessToken,
  RedirectRequestContract,
} from '@adonisjs/ally/types'

export type ZeroAccountAccessToken = Oauth2AccessToken & {
  id_token?: string
  idToken?: string
}

export type ZeroAccountScope = 'openid' | 'profile' | 'email' | 'offline_access' | (string & {})

export type ZeroAccountConfig = {
  driver: 'zeroaccount'
  clientId: string
  clientSecret: string
  callbackUrl: string
  scopes?: ZeroAccountScope[]
  authorizeUrl?: string
  accessTokenUrl?: string
  userInfoUrl?: string
}

export class ZeroAccountDriver
  extends Oauth2Driver<ZeroAccountAccessToken, ZeroAccountScope>
  implements AllyDriverContract<ZeroAccountAccessToken, ZeroAccountScope>
{
  protected authorizeUrl = 'https://v1.0account.com/oauth/authorize'
  protected accessTokenUrl = 'https://v1.0account.com/oauth/token'
  protected userInfoUrl = 'https://v1.0account.com/oauth/userinfo'
  protected codeParamName = 'code'
  protected errorParamName = 'error'
  protected stateCookieName = 'zeroaccount_oauth_state'
  protected stateParamName = 'state'
  protected scopeParamName = 'scope'
  protected scopesSeparator = ' '
  private codeVerifierCookieName = 'zeroaccount_code_verifier'

  constructor(
    ctx: HttpContext,
    public config: ZeroAccountConfig
  ) {
    super(ctx, config)
    this.loadState()
  }

  protected configureRedirectRequest(request: RedirectRequestContract<ZeroAccountScope>) {
    request.param('response_type', 'code')
    request.scopes(this.config.scopes || ['openid', 'profile', 'email'])
    const verifier = randomBytes(32).toString('base64url')
    this.ctx.response.encryptedCookie(this.codeVerifierCookieName, verifier, {
      sameSite: false,
      httpOnly: true,
    })
    request.param('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    request.param('code_challenge_method', 'S256')
  }

  protected configureAccessTokenRequest(request: ApiRequestContract) {
    const verifier = this.ctx.request.encryptedCookie(this.codeVerifierCookieName)
    this.ctx.response.clearCookie(this.codeVerifierCookieName)
    if (verifier) {
      request.field('code_verifier', verifier)
    }
  }

  accessDenied() {
    const error = this.getError()
    if (!error) {
      return false
    }
    return error === 'access_denied' || error === 'login_required'
  }

  async accessToken(
    callback?: (request: ApiRequestContract) => void
  ): Promise<ZeroAccountAccessToken> {
    const token = await super.accessToken(callback)
    return { ...token, idToken: token.id_token }
  }

  async user(
    callback?: (request: ApiRequestContract) => void
  ): Promise<AllyUserContract<ZeroAccountAccessToken>> {
    const token = await this.accessToken(callback)
    const user = await this.getUserInfo(token.token, callback)
    return { ...user, token }
  }

  async userFromToken(
    accessToken: string,
    callback?: (request: ApiRequestContract) => void
  ): Promise<AllyUserContract<{ token: string; type: 'bearer' }>> {
    const user = await this.getUserInfo(accessToken, callback)
    return { ...user, token: { token: accessToken, type: 'bearer' } }
  }

  protected getAuthenticatedRequest(url: string, token: string) {
    const request = this.httpClient(url)
    request.header('Authorization', `Bearer ${token}`)
    request.header('Accept', 'application/json')
    request.parseAs('json')
    return request
  }

  protected async getUserInfo(token: string, callback?: (request: ApiRequestContract) => void) {
    const request = this.getAuthenticatedRequest(this.config.userInfoUrl || this.userInfoUrl, token)
    if (typeof callback === 'function') {
      callback(request)
    }

    const body = (await request.get()) as ZeroAccountUserInfo
    const name = [body.given_name, body.family_name].filter(Boolean).join(' ')
    return {
      id: body.sub,
      nickName: name,
      name,
      email: body.email || null,
      emailVerificationState: body.email
        ? body.email_verified
          ? ('verified' as const)
          : ('unverified' as const)
        : ('unsupported' as const),
      avatarUrl: body.picture || null,
      original: body,
    }
  }
}

type ZeroAccountUserInfo = {
  sub: string
  given_name?: string
  family_name?: string
  email?: string
  email_verified?: boolean
  picture?: string
  [key: string]: unknown
}

export function ZeroAccountService(
  config: ZeroAccountConfig
): (ctx: HttpContext) => ZeroAccountDriver {
  return (ctx) => new ZeroAccountDriver(ctx, config)
}
