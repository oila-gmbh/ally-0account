# ally-0account

An [AdonisJS Ally](https://docs.adonisjs.com/guides/authentication/social-authentication) driver for [0account](https://0account.com).

0account supports standard OpenID Connect protocol, and this driver speaks its authorization code flow with PKCE (S256) out of the box.

## Install

```sh
npm i ally-0account
```

## Usage

Register the driver in `config/ally.ts`:

```ts
import env from '#start/env'
import { defineConfig } from '@adonisjs/ally/types'
import { ZeroAccountService } from 'ally-0account'

const allyConfig = defineConfig({
  zeroaccount: ZeroAccountService({
    clientId: env.get('ZEROACCOUNT_CLIENT_ID')!,
    clientSecret: env.get('ZEROACCOUNT_CLIENT_SECRET')!,
    callbackUrl: 'https://your-app.com/ally/zeroaccount/callback',
  }),
})

export default allyConfig
```

Then use it from a controller as with any Ally driver:

```ts
const ally = this.ally.use('zeroaccount')

if (ally.accessDenied()) {
  return 'The sign-in attempt expired or was declined. Please try again.'
}

const user = await ally.user()
```

## Configuration

| Option | Required | Description |
|---|---|---|
| `driver` | yes | Must be `'zeroaccount'`. |
| `clientId` | yes | The app id from [my.0account.com/apps](https://my.0account.com/apps). |
| `clientSecret` | yes | The app secret (`0account_sec_…`), sent exactly as issued. |
| `callbackUrl` | yes | Must be registered as a redirect URI for the app. |
| `scopes` | no | Defaults to `['openid', 'profile', 'email']`. Add `'offline_access'` to receive a refresh token. |
| `authorizeUrl` | no | Overrides `https://v1.0account.com/oauth/authorize`. |
| `accessTokenUrl` | no | Overrides `https://v1.0account.com/oauth/token`. |
| `userInfoUrl` | no | Overrides `https://v1.0account.com/oauth/userinfo`. |

## Behaviour notes

- **PKCE is handled for you.** 0account requires `code_challenge` (S256) on every authorization request. The driver generates a fresh verifier per redirect and round-trips it in an encrypted `zeroaccount_code_verifier` cookie, alongside the usual `zeroaccount_oauth_state` state cookie.
- **Declined and expired attempts** come back as `error=login_required` on the callback, which `accessDenied()` reports. Catch it and restart the flow.
- **Refresh tokens** are only issued when the granted scopes include `offline_access`; without it the token response carries no `refresh_token`.
- **The user mapping:** `id` ← `sub` (a pairwise subject, unique per app), `name`/`nickName` ← `given_name` + `family_name`, `email` ← `email` with `emailVerificationState` reflecting the `email_verified` claim (0account only issues verified addresses, so it is `'verified'` in practice), `avatarUrl` ← `picture`. The complete userinfo response — including every approved custom field under the `https://0account.com/claims/fields` namespace — is available as `user.original`.
- **`id_token`** is exposed as `user.token.idToken` without signature validation. The driver treats userinfo as the source of identity, like every built-in Ally driver.
- Custom fields are not requested with scopes: the app declares its fields in the 0account admin panel, the user consents to them in the app, and whatever was approved arrives in userinfo.

## Development

```sh
npm install
npm test
npm run build
```

## License

MIT
