# Landing and authentication

A human can enter from the public landing page, create an account, and return to a protected room list after signing in.

## Sub-features

- `landing-entry` verifies all three **进入房间** links and the navigation **登录** link.
- `auth-gate` verifies the protected route and return path.
- `auth-register` creates and signs in a human account with a username.
- `auth-login` verifies logout, incorrect password, successful login, and reload.
- `auth-providers` verifies optional email-code and Google entry paths when the providers are configured.

## How to get to it (user POV)

- At `/`, select **进入房间** in the main navigation, hero, or closing section. Each opens `/login?next=%2Fhome`.
- Select **登录** in the landing navigation, or open `/login` directly.
- Open `/home` while signed out. On the login page select **注册账号**. A direct sign-up link also opens `/login?mode=register`.
- Return to the login page through the signed-in account menu and **退出登录**.

## Driving it with browser-harness

Preconditions: doctor passes for a new instance, with no existing `parlor_verify` account.

1. Run `.cursor/skills/verify-parlor/scripts/drive-auth.sh "$PARLOR_RUN"` from the repo root. It verifies all **进入房间** links, **登录**, the protected redirect, registration, logout, password rejection, successful login, and session after reload. Expect an accessibility snapshot per main state, HTTP 200 for successful session actions, HTTP 401 for the incorrect password, and `parlor_verify|human|t` in `01-auth-db.txt`. The driver attempts a screenshot after reload.
2. With an isolated email or Google fixture supplied, open `/login` and use **获取验证码** with a controlled inbox, or **使用 Google 继续** with a dedicated test identity. Complete the provider flow and confirm the signed-in identity and `/home` from a fresh page. Verify registration and subsequent login separately for email.

## Gotchas

- The baseline intentionally disables email and Google. Their user paths require separately configured fixtures.
- The automated helper registers a fixed synthetic username. Launch a fresh run for a full replay.
- Preserve HTTP status metadata and the limited SQL projection. Auth response bodies contain access tokens.
