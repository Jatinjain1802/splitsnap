'use strict';
// Email delivery is OFF unless a mailer is configured. MAIL_MODE=console is for local development only:
// it prints the message (including the link) to the server console and sends nothing.
function getMailer() {
  if (process.env.MAIL_MODE === 'console') {
    return { dev: true, async send(to, subject, text) { console.log(`[DEV MAIL, not delivered] to=${to}\nsubject: ${subject}\n${text}\n`); } };
  }
  return null; // plug in a real provider here: return { send(to, subject, text) { ... } }
}
module.exports = { getMailer };
