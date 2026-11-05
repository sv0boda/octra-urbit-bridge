// Import into the Circle frontend build. The host supplies window.OctraCircle.
// Every call goes through the configured shared relayer; never fetch a ship here.
import {isOctraAddress, REPORTED_WALLET_KIND} from '../shared/guest-identity.mjs';

export function reportedWalletReader(bridge) {
  let sessionAddress;
  return async () => {
    const wallet = await bridge.request('wallet.info');
    if (!isOctraAddress(wallet?.address)) throw new Error('Open an Octra wallet before entering the room');
    if (sessionAddress && wallet.address !== sessionAddress) throw new Error('Your active wallet changed. Reopen the room to use that guest profile.');
    sessionAddress = wallet.address;
    // public_key and any other wallet metadata are deliberately not forwarded.
    return {kind: REPORTED_WALLET_KIND, address: wallet.address};
  };
}

export function circleTransport({bridge, authentication}) {
  if (!bridge || typeof bridge.request !== 'function') throw new Error('Open this app inside an Octra Circle');
  authentication ??= reportedWalletReader(bridge);
  if (typeof authentication !== 'function') throw new Error('Guest identity is not configured');
  return async function request(method, params = {}) {
    const result=await bridge.request('relay.request',{
      app:'octra-tlon-alpha',version:1,method,params,auth:await authentication()
    });
    if (!result || result.ok !== true) throw new Error(result?.error || 'The shared relay did not accept the request');
    return result.result;
  };
}
