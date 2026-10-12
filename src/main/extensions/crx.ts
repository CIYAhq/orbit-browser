import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto'
import { CrxError, crxSignedPrefix, idFromHash, parseCrx } from '../../shared/extensions'

/**
 * Verifying a CRX3 file (EX-01, EX-09) before anything in it is used: every proof in its header must
 * be a valid signature over its signed data and archive, and one proof's key must be the extension's
 * own, the key whose hash is the ID the header names. Verifying runs off main's thread.
 */

/** A SHA-256 signature check, on libuv's thread pool (Node's `verify` with a callback). */
const verifyAsync = (data: Buffer, key: KeyObject, signature: Buffer) =>
  new Promise<boolean>((resolve, reject) =>
    verify('sha256', data, key, signature, (err, ok) => (err ? reject(err) : resolve(ok))),
  )

export interface VerifiedCrx {
  /** The extension's ID, from its own key. */
  id: string
  /** Its own key (DER SubjectPublicKeyInfo): the installed manifest's `key`, so the engine gives it the same ID. */
  publicKey: Uint8Array
  /** The ZIP archive, now known to be what was signed. */
  archive: Uint8Array
}

/** Checks a CRX3 file; `expectedId`, when given, must be the ID it names. Throws CrxError with the reason. */
export async function verifyCrx(bytes: Uint8Array, expectedId?: string): Promise<VerifiedCrx> {
  const crx = parseCrx(bytes)
  if (!crx.crxId) throw new CrxError('Its header names no extension.')
  const id = idFromHash(crx.crxId)
  const signed = Buffer.concat([crxSignedPrefix(crx.signedHeaderData), crx.archive])
  let own: Uint8Array | undefined
  for (const proof of crx.proofs) {
    let ok = false
    try {
      const key = createPublicKey({ key: Buffer.from(proof.publicKey), format: 'der', type: 'spki' })
      const kind = key.asymmetricKeyType
      if ((proof.algorithm === 'rsa' && kind !== 'rsa') || (proof.algorithm === 'ecdsa' && kind !== 'ec')) {
        throw new CrxError('A signature in its header is of the wrong kind.')
      }
      ok = await verifyAsync(signed, key, Buffer.from(proof.signature))
    } catch (err) {
      if (err instanceof CrxError) throw err
      ok = false
    }
    if (!ok) throw new CrxError('Its signature doesn’t match its contents.')
    if (!own && idFromHash(createHash('sha256').update(proof.publicKey).digest()) === id) own = proof.publicKey
  }
  if (!own) throw new CrxError('It isn’t signed with its own key.')
  if (expectedId !== undefined && id !== expectedId) throw new CrxError('It isn’t the extension that was asked for.')
  return { id, publicKey: own, archive: crx.archive }
}
