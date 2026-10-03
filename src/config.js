import { validPromptPay } from './lib/promptpay.js';

// Facebook page link (any facebook.com / fb.me URL) for the "เพจ Facebook" button.
const facebookUrl = v => (/^https:\/\/(www\.|m\.)?(facebook\.com|fb\.me|fb\.com)\/[^\s"<>]+$/.test(v || '') ? v : '');
// Messenger chat needs the page username (e.g. oongtongmedia) or numeric page id → https://m.me/<id>.
const messengerUrl = v => (/^[A-Za-z0-9.]{3,80}$/.test(v || '') ? `https://m.me/${v}` : '');

export function shopConfig(env) {
  const ready = validPromptPay(env.PROMPTPAY_ID) && !!env.ACCOUNT_NAME?.trim();
  return {
    shopName: env.SHOP_NAME || 'อองตองมีเดีย',
    promptPayId: env.PROMPTPAY_ID || '',
    bankName: env.BANK_NAME || '',
    accountName: env.ACCOUNT_NAME || '',
    accountNo: env.ACCOUNT_NO || '',
    lineOaId: env.LINE_OA_ID || '',
    facebookUrl: facebookUrl(env.FACEBOOK_PAGE_URL),
    messengerUrl: messengerUrl(env.FACEBOOK_PAGE_ID),
    appEnv: env.APP_ENV || 'production',
    ready
  };
}
