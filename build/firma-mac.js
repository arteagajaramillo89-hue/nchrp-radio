// Firma "ad hoc" gratuita para el Mac (sin cuenta de Apple Developer).
// Sin esto, los Mac con chip M1/M2/M3 dicen que la app "está dañada". No sustituye a una firma de Apple:
// la primera vez hay que abrirla con clic derecho > Abrir.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  console.log('Firma ad hoc de', app);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
