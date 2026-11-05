# Social Bridge message costs

All amounts below are **devnet OCT**, not mainnet OCT. These are the alpha's current successful-call estimates as of 5 November 2026. Check the wallet confirmation for the actual fee.

| Action | Visitor pays | Bridge operator pays |
| --- | ---: | ---: |
| Read or refresh the chat | 0 | 0 in chain fees |
| Send a Circle message to Tlon | 0.001 OCT | 0.001 OCT for its delivery acknowledgement |
| Mirror one Urbit post or reply into the Circle | 0 | 0.001 OCT |
| Publish changed Tlon reaction counts | 0 | 0.001 OCT per batch |

Reaction changes and removals are checked only when a new chat message arrives. Changes observed together are batched; unchanged checks incur no write fee.

One Octra message followed by one Urbit reply costs the visitor **0.001 devnet OCT** and the operator **0.002 devnet OCT**, before any changed reaction batch. Publication is paid once for the room, not once per reader.

## Devnet funds

Use the gated [Telegram faucet bot](https://t.me/octradevbot). The limits provided for this guide are **3 OCT per day, 10 OCT per week, and 33 OCT per month**. Follow the bot's access requirements and current rules, and do not try to bypass them.

At 0.001 OCT per message, 3 OCT covers **3,000 message fees**, before other transactions. The room's separate rate limits still apply; please do not spam.

## Sending and retries

Enter **0** as the attached amount. The transaction fee is separate. A timeout does not prove that a transaction failed: use the room's read-only status check and wait for confirmation before attempting a fresh send. Failed-transaction fee treatment can differ; do not assume fees are always refunded.

These figures exclude hosting, bandwidth, maintenance, and future changes in network fees. See the [visitor guide](OCTRA-USER-GUIDE.md) for devnet settings, wallet prompts, and troubleshooting.
