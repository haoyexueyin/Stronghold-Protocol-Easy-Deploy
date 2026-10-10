// Optional native HTTPS. Certificates stay outside all static mounts.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const LOCAL_PFX = path.join(ROOT, 'certs', 'local.pfx');

/** Explicit options win; otherwise use configured certificates or the Windows local certificate. */
export function httpsEnabled(tls) {
  if (tls !== undefined) return tls !== false;
  const flag = process.env.SP_HTTPS;
  if (flag !== undefined && flag !== '') {
    if (/^(0|false|no)$/i.test(flag)) return false;
    if (/^(1|true|yes)$/i.test(flag)) return true;
    throw new Error('SP_HTTPS must be 1 or 0');
  }
  return !!(process.env.SP_TLS_PFX || process.env.SP_TLS_CERT || process.env.SP_TLS_KEY || fs.existsSync(LOCAL_PFX));
}

/**
 * @param {import('node:https').ServerOptions | false} [tls]
 * @returns {import('node:https').ServerOptions | null}
 */
export function loadTlsOptions(tls) {
  if (!httpsEnabled(tls)) return null;
  if (tls && typeof tls === 'object') return { minVersion: 'TLSv1.2', ...tls };
  const { SP_TLS_CERT: cert, SP_TLS_KEY: key, SP_TLS_PFX: pfx, SP_TLS_PASSPHRASE: passphrase } = process.env;
  if (pfx && (cert || key)) throw new Error('Use SP_TLS_PFX or SP_TLS_CERT + SP_TLS_KEY, not both');
  const read = (file) => fs.readFileSync(path.resolve(ROOT, file));
  try {
    if (cert || key) {
      if (!cert || !key) throw new Error('SP_TLS_CERT and SP_TLS_KEY must be set together');
      return { cert: read(cert), key: read(key), passphrase, minVersion: 'TLSv1.2' };
    }
    return { pfx: read(pfx || LOCAL_PFX), passphrase, minVersion: 'TLSv1.2' };
  } catch (e) {
    throw new Error(`HTTPS certificate unavailable: ${e.message}. Run scripts\\start-https-windows.bat or configure SP_TLS_CERT + SP_TLS_KEY.`, { cause: e });
  }
}
