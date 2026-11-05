# Operate your own devnet bridge

The visitor guide connects to the existing public demo. These instructions are for a separate deployment with your own identities. This is an alpha reference implementation, not a one-command hosting service.

## Requirements

- Node.js 22.13+, Python 3, and curl (`/usr/bin/curl` for the Node RPC adapter).
- A dedicated Urbit ship or moon running a compatible Tlon installation, joined to your target group/channel with permission to post.
- Private access from the gateway host to that ship's HTTP API. Use loopback or authenticated HTTPS infrastructure; do not expose ship credentials to Circle visitors.
- A devnet wallet dedicated to the bridge, funded with test OCT. It pays for deployment, acknowledgements, and returned Urbit messages.

The adapter uses Tlon channel v5 history and `channel-action-2` pokes. Validate against your ship's installed version. The signing code is pinned to devnet and verifies the chain identifier before writes; changing the RPC alone does not make this a mainnet deployment.

## 1. Configure your target

```sh
mkdir -p .private evidence
chmod 700 .private
cp config/target.example.json config/target.json
```

Edit `config/target.json` with your real `hostPlanet`, `gatewayMoon`, group flag, channel nest, and `moonOrigin`. The example ship names are placeholders, not deployable identities. Keep `postingEnabled` false until you have verified all targets.

Save the gateway moon's login code locally as `.private/moon-web-login.txt`, mode 0600. Do not commit it, print it in logs, or put it in browser code. The worker checks that the authenticated ship matches `gatewayMoon`.

```sh
chmod 600 .private/moon-web-login.txt
node scripts/prepare-operator.mjs
```

The preparation script generates a dedicated Ed25519 key in `.private/circle-operator.pk8` and writes its public metadata to ignored `config/operator.json`. It preserves an existing key. Fund the printed public address with a small amount of devnet OCT using your wallet or the gated faucet; the repository does not automate transfers from another wallet.

## 2. Compile and deploy the queue

```sh
python3 scripts/compile-queue.py
node scripts/circle.mjs deploy
```

Compilation uses the public devnet compiler and does not submit a transaction. The second command prepares an unsigned deployment summary. Review it, then explicitly submit:

```sh
node scripts/circle.mjs deploy --apply
node scripts/circle.mjs status
```

Wait for confirmation. `status` verifies the deployed operator and saves the Circle ID into your target configuration. Deployment currently has a 0.2 devnet OCT fee cap. A changed chain/fee recommendation stops signing for review.

## 3. Build and publish the page

Review the room name and explanatory text in `web/circle.html` for your own community, then:

```sh
npm run build
node scripts/circle.mjs upload
node scripts/circle.mjs upload --apply
```

Wait for the upload transaction to confirm before running `node scripts/circle.mjs asset-status`. This checks exact published asset bytes. Open `oct://YOUR_CIRCLE_ID/index.html` in the devnet wallet. The supplied publisher supports pages up to 32 KiB; asset fees depend on size, with a 0.02 devnet OCT cap for that supported range.

## 4. Start forwarding

Check the target group and channel, moon membership, operator funds, and confirmed Circle. Set `postingEnabled` to true in your local target file, then:

```sh
node scripts/run-gateway.mjs
```

The foreground worker runs approximately every 15 seconds. Use your own service supervisor for continuous operation. Configure graceful SIGTERM shutdown and private logs. A local SQLite lock prevents concurrent workers; a separate lock serializes signing.

`evidence/gateway-status.json` reports the most recent cycle. `idle` means caught up, `waiting-for-confirmation` means a transaction is pending, and `ok:false` needs investigation. A stale timestamp means the worker is not reporting current health.

Test a message from a separate visitor wallet and a native Urbit reply. Confirm each appears once with the expected guest label/ship identity and thread. Verify an orderly worker restart preserves that result. Local synthetic tests do not substitute for these deployment checks.

## Preserve state and reconcile uncertainty

Back up `.private/gateway.sqlite`, `.private/operator-outbox/`, the dedicated key, and the ship using appropriate stopped/consistent backups. These contain private operational state and must stay out of Git. Do not delete an outbox entry to force another submission: a timeout does not establish failure. Check the saved transaction hash and native history before deciding how to recover an uncertain or expired operation.

Do not run two copies of a live Urbit pier. Stop the worker before performing ship or program maintenance. Pausing forwarding does not disable the public Circle queue; visitors can still submit messages.

## Program updates and fees

To update your own queue, compile first and compare storage keys and method behavior with the deployed version. After pausing forwarding, `node scripts/circle.mjs update-program` previews the transaction and `--apply` submits it. Verify existing records and views before resuming. This operation currently has a 0.2 devnet OCT cap.

Guest calls and operator publications currently cost 0.001 devnet OCT each. Unchanged reads do not incur chain fees. Reactions are checked only after a new chat message, then all observed changes are sent in one snapshot. See [costs](COSTS.md). There is no automatic balance top-up.

### Tlon post compatibility

Plain bridge messages use `blob: null`. Tlon treats unrecognized blob payloads as unsupported content and displays an upgrade warning. Delivery correlation lives in SQLite: an attempted send must match the gateway author, original timestamp, exact attributed text, and thread. Ambiguous matches stop for inspection instead of being resent. Legacy bridge blobs remain readable for reconciliation, but new posts do not emit them. Existing posts from older deployments can be repaired in place after confirming their native IDs and delivery records; preserve the essay, replies and reactions, changing only the unsupported blob.
