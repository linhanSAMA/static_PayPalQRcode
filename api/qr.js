// api/qr.js - Vercel Serverless Function
// 功能：用 PayPal Invoice API 按金额动态生成 QR 码

export default async function handler(req, res) {
  // 允许跨域（店匠页面可以调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { amount, currency = 'USD', note = '' } = req.query;

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: '请提供有效金额' });
  }

  try {
    // 第一步：获取 PayPal Access Token
    const authRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET
        ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const authData = await authRes.json();
    const accessToken = authData.access_token;
    if (!accessToken) throw new Error('PayPal 授权失败，请检查 Client ID 和 Secret');

    // 第二步：创建 Invoice（草稿，不发送邮件给买家）
    const invoiceRes = await fetch('https://api-m.paypal.com/v2/invoicing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        detail: {
          currency_code: currency,
          note: note || 'PayPal 扫码支付',
          payment_term: { term_type: 'DUE_ON_RECEIPT' },
        },
        items: [{
          name: '订单付款',
          quantity: '1',
          unit_amount: { currency_code: currency, value: Number(amount).toFixed(2) },
        }],
      }),
    });

    const invoiceData = await invoiceRes.json();

    // PayPal 返回链接数组，从 self 链接里提取 Invoice ID
    let invoiceId = invoiceData.id;
    if (!invoiceId && Array.isArray(invoiceData)) {
      const selfLink = invoiceData.find(link => link.rel === 'self');
      if (selfLink) {
        invoiceId = selfLink.href.split('/').pop();
      }
    }
    if (!invoiceId) throw new Error('无法提取 Invoice ID：' + JSON.stringify(invoiceData));

    // 第三步：发送 Invoice（状态变为 SENT，才能生成 QR 码）
    await fetch(`https://api-m.paypal.com/v2/invoicing/invoices/${invoiceId}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ send_to_recipient: false }), // 不给买家发邮件
    });

    // 第四步：生成 QR 码（返回 Base64 图片）
    const qrRes = await fetch(
      `https://api-m.paypal.com/v2/invoicing/invoices/${invoiceId}/generate-qr-code`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ width: 300, height: 300 }),
      }
    );

    const qrBuffer = await qrRes.arrayBuffer();
    const qrBase64 = Buffer.from(qrBuffer).toString('base64');

    return res.status(200).json({
      success: true,
      invoiceId,
      qrBase64,          // 前端用 <img src="data:image/png;base64,{qrBase64}"> 显示
      amount: Number(amount).toFixed(2),
      currency,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
