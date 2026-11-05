# Visit Urbit Social Bridge in Octra Circles

Chat with people in **Octra Social Bridge / Bridge chat** on Tlon, using your Octra wallet. You do not need an Urbit identity, your own moon, a relay URL or anything from this repository to join.

This is a **public devnet alpha**. Messages, nicknames and wallet addresses are public. Your Octra address gives you a persistent guest identity; Urbit participants see your nickname on messages sent by a shared gateway moon.

## Before you start

Use an up-to-date [official Octra webcli wallet](https://github.com/octra-labs/webcli) with Circles support. If you need to install it, follow the [official client installation guide](https://docs.octra.org/user-docs/installing-the-client) and [wallet setup guide](https://docs.octra.org/user-docs/generating-a-wallet).

## 1. Switch the wallet to devnet

These instructions are for the official **Octra webcli wallet**, checked against its current source on **5 November 2026**. Other wallet interfaces may differ. In this version, network selection is done by editing the RPC URL in Settings; there is no mainnet/devnet dropdown.

1. Open and unlock your Octra wallet. For a standard local webcli installation, the address is `http://127.0.0.1:8420`.
2. Open **settings** in the wallet navigation, then find **network settings**.
3. Save a copy of your existing RPC and explorer URLs so you can restore them later.
4. Enter these values:

   | Field | Devnet value |
   | --- | --- |
   | **rpc url** | `https://devnet.octrascan.io/rpc` |
   | **explorer url** | `https://devnet.octrascan.io` |
   | **relayer url** | Leave your existing value unchanged; this room does not use it. |

5. Click **save**. The wallet asks for your PIN to confirm the settings change. Enter it in the wallet's own dialog.
6. Wait for the saved confirmation. Return to the dashboard and check that the wallet header says **dev net**. If necessary, reload the wallet and unlock it again. Reopen Settings to verify that the saved RPC URL ends in `/rpc`.

**Changing only the explorer URL does not switch networks.** The RPC URL determines which chain the wallet uses. Switching networks changes the balance/history you are viewing; it does not move your funds between mainnet and devnet. A mainnet balance will not pay this room's devnet fees.

The wallet implementation updates its endpoint and clears cached network data on save. Exact controls and behavior: [settings form](https://github.com/octra-labs/webcli/blob/52fca461dd2e81652dec588f0ab861662bf38cf6/static/index.html#L499), [save handler](https://github.com/octra-labs/webcli/blob/52fca461dd2e81652dec588f0ab861662bf38cf6/static/wallet.js#L4295), [network label](https://github.com/octra-labs/webcli/blob/52fca461dd2e81652dec588f0ab861662bf38cf6/static/wallet.js#L1213).

## 2. Have a little devnet OCT available

Reading the chat has no transaction fee. Sending a message currently costs **0.001 devnet OCT** from your wallet's spendable public balance. For example, **0.01 devnet OCT covers 10 successful sends** at that fee, before any other transactions.

Get devnet OCT from the gated [Octra devnet faucet bot on Telegram](https://t.me/octradevbot). Follow the bot's access requirements and claim instructions. The limits provided for this guide are **3 OCT per day, 10 OCT per week, and 33 OCT per month**; the bot's current rules take precedence if they change.

Please respect the limits and do not try to bypass them. At the current **0.001 devnet OCT per message**, 3 OCT covers **3,000 message fees** before other transactions—plenty for trying the bridge. This is a fee estimate, not a promise of message throughput; the room also has rate limits.

If you cannot access the bot, ask the room operator for help and provide only your public `oct…` address. Funding is not automatic. You do not need to buy mainnet OCT for this alpha or give anyone your private key, seed or PIN.

## 3. Open the room in Circles

1. Click **circles** in the wallet header.
2. In **circle browser**, paste this full address into **circle uri or id**:

   ```text
   oct://oct3K5KsomirPMaPrGZC2dRv7ZvirdAm6WV7DybuH3gePYe/index.html
   ```

3. Leave **sealed read passphrase** empty. This room is public.
4. Click **open**. The page should show **Urbit Social Bridge**, **Octra × Urbit**, and **DEVNET ALPHA**.
5. Click **Enter with Octra wallet**. The wallet asks separately for your active wallet address and permission to read room data. Both dialogs are called **runtime access**, but their descriptions differ. Allow each if you wish to join. The page shows step 1, step 2, then **Access granted. Loading the conversation…**. Neither permission sends a payment.

Paste the `oct://` address into the wallet's Circle browser, not your ordinary browser's address bar. There is no custom relay field to configure. [Official Circle browser controls](https://github.com/octra-labs/webcli/blob/52fca461dd2e81652dec588f0ab861662bf38cf6/static/circles.html#L444).

## 4. Send a message or reply

1. Set a nickname and type your message. Short nicknames work best; the limit is 24 UTF-8 bytes, so emoji and some scripts use more than one byte per character.
2. Click **Send message**. For a threaded reply, first click **Reply** under an existing message.
3. Allow program calls for this Circle if the wallet asks for that session permission.
4. In the first dialog, **program call amount**, enter **`0`** and click **continue**. This is the amount attached to the call, not the fee. The chat program requires zero attached OCT.
5. The second dialog is titled **confirm program call**. Its input is for **your wallet PIN**, even though the wallet currently does not label it explicitly. Review this Circle, method `send`, zero attached amount, and currently **0.001 OCT** in fees. Enter your PIN here and click **sign**. The second input takes your PIN, not another amount.
6. The draft becomes unavailable for editing during approval. Once the wallet returns a transaction receipt, the page shows **Transaction submitted** and a devnet Octrascan address. It checks automatically, approximately every 10 seconds plus read time, then shows **Message confirmed on devnet** and finally **Delivered to Tlon**. You may compose another message after confirmation. If your wallet blocks opening explorer links, select and copy the displayed address into your browser.

These are the [wallet's native amount and PIN prompts](https://github.com/octra-labs/webcli/blob/52fca461dd2e81652dec588f0ab861662bf38cf6/static/circles.js#L921). The page itself never needs your PIN or private key.

| Status | Meaning |
| --- | --- |
| Waiting for wallet approval | Finish the amount and PIN prompts in your wallet. |
| Checking submission status | The wallet response was lost or uncertain; the app checks without resubmitting. |
| Transaction submitted | The wallet submitted a transaction; settlement is still pending. |
| Confirmed · waiting for Tlon | Devnet accepted the message; the gateway has not yet confirmed delivery. |
| Delivered to Tlon | The message reached the Tlon channel and its acknowledgement is on devnet. |
| From Tlon | An Urbit participant's message was published back into the Circle. |

Urbit replies appear with the participant's ship name. Your guest identity follows the same wallet address when you return. Nickname changes are saved with your next successful send; older messages keep their original label.

## Fees at a glance

| Action | You pay | Room operator pays |
| --- | ---: | ---: |
| Read / refresh the room | 0 | 0 in chain fees |
| Send one Circle message to Tlon | 0.001 devnet OCT | 0.001 devnet OCT for the delivery acknowledgement |
| Sync changed Tlon reactions after a new message | 0 | 0.001 devnet OCT per changed reaction snapshot published by the bridge |
| Receive one new message from Urbit | 0 | 0.001 devnet OCT to publish it into the Circle |

These are current successful-call costs, verified on 5 November 2026, not fixed future prices. A single guest message followed by one Urbit reply costs **0.001 OCT to the guest and 0.002 OCT to the operator**. Reaction sync calls are additional when counts change. See [cost estimates and operator budget](COSTS.md).

## If something does not work

- **Circle not found / wrong balance:** check the RPC URL in Settings and the `dev net` header, then reopen Circles.
- **No Circles button:** these steps target the official webcli with Circles support. Compare your version with the [official wallet repository](https://github.com/octra-labs/webcli); this guide does not cover unrelated wallet apps.
- **Insufficient funds:** you need spendable public devnet OCT. Mainnet or encrypted funds are not the balance this transaction uses directly.
- **`circle view busy`:** wait and refresh. The UI retries temporary read contention; repeated errors may indicate RPC load.
- **`RPC HTTP 429`:** the RPC is limiting requests. The room pauses for 30 seconds, increasing to at most two minutes on repeated limits, then checks automatically. Keep the page open; do not sign the message again. A 429 after sending does not prove failure—check the existing transaction in wallet history. Loaded messages remain visible during recovery.
- **Submission interrupted:** keep the page open and use **Check status**. This only reads; it never signs or submits another transaction. The draft stays locked until confirmation. A wallet timeout does not prove failure. If the transaction remains unconfirmed, check the explorer or wallet history and contact the operator before trying a fresh send. Reopening the room loses its in-memory receipt, though the same text/nickname/thread still identifies an already confirmed message.
- **Confirmed but not delivered:** the operator's bridge, moon or acknowledgement transaction may be delayed. Do not send a different copy just to bypass the wait; contact the operator if it persists.
- **Message rate limit:** the alpha allows three sends per wallet per epoch. Wait for the chain to advance; an epoch is not a fixed number of seconds.
- **Changed active wallet:** reopen the room. A session refuses wallet switches to avoid attributing a message to the wrong account.

Identical text from the same wallet and nickname in the same thread is treated as a retry, even after reopening the room. That is an alpha limitation. The UI shows the latest 50 records, so an older reply's parent may be outside the visible window. Posts and replies are text-only; edits, deletion and attachments are not supported. Emoji reactions from Tlon appear as badges with counts on the corresponding post or reply. Reaction changes and removals wait until the next new chat message before being checked, then require bridge processing and devnet confirmation before appearing. Adding reactions from the Circle itself is not yet supported.

## Return to your previous network

Return to the wallet's **settings**, restore the RPC and explorer URLs you saved earlier, and click **save**, confirming with your PIN. Verify the resulting network label. Reopen any Circle tabs after changing networks; this room's address belongs to devnet.

## Test status

The deployed bridge has passed live Circle → dedicated moon → Tlon → Circle tests, including threading and restart deduplication. Browser checks use the official public prelude with a controlled wallet host. One real visitor wallet has now completed the amount/PIN flow: its message was confirmed once and delivered to Tlon, with one 0.001 OCT fee. Testing across additional wallets and client versions remains open. The wallet steps were checked against official source and this visitor report.
