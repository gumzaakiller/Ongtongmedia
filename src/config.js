import { validPromptPay } from './lib/promptpay.js';

export function shopConfig(env) {
  const ready = validPromptPay(env.PROMPTPAY_ID) && !!env.ACCOUNT_NAME?.trim();
  return {
    shopName: env.SHOP_NAME || 'อองตองมีเดีย',
    promptPayId: env.PROMPTPAY_ID || '',
    bankName: env.BANK_NAME || '',
    accountName: env.ACCOUNT_NAME || '',
    accountNo: env.ACCOUNT_NO || '',
    lineOaId: env.LINE_OA_ID || '',
    appEnv: env.APP_ENV || 'production',
    ready
  };
}
