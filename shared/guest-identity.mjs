// Alpha policy selected by the owner: trust the address reported by the client.
// Format validation is not an ownership proof. This namespace must remain
// separate from any future verified-wallet or administrative identity.
export const REPORTED_WALLET_KIND = 'octra-address-reported';
export const isOctraAddress = value => typeof value === 'string' && /^oct[1-9A-HJ-NP-Za-km-z]{44}$/.test(value);

export function reportedWalletIdentity(auth) {
  if (!auth || auth.kind !== REPORTED_WALLET_KIND || !isOctraAddress(auth.address)) return null;
  return {account: `reported-octra:${auth.address}`, kind: REPORTED_WALLET_KIND};
}
