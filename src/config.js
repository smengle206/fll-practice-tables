// The address coaches use. Printed on handouts (QR code) and shown on the TV display.
// Override with the PUBLIC_URL variable in Railway if the domain ever changes.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tables.darfll.org').replace(/\/+$/, '');

module.exports = { PUBLIC_URL };
