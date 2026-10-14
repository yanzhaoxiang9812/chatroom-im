// Vercel Serverless Function：生成腾讯云IM UserSig（零外部依赖，Node 内置 crypto/zlib）
// 访问：GET /api/genUserSig?userId=xxx  ->  { "userSig": "..." }
// 环境变量（在 Vercel 项目设置里配置，绝不放前端/不进仓库）：
//   TIM_SDKAPPID  = 腾讯云IM SDKAppID（数字）
//   TIM_SECRETKEY = 腾讯云IM 密钥(SecretKey)
// 同源部署于 Vercel，前端相对路径调用，无需 CORS。
const crypto = require('crypto');
const zlib = require('zlib');

function base64urlEscape(str) {
  return str.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

// 官方 genUserSig 算法（无 userbuf 版本）
function genUserSig(sdkappid, key, userid, expire) {
  const currTime = Math.floor(Date.now() / 1000);
  const contentToBeSigned =
    'TLS.identifier:' + userid + '\n' +
    'TLS.sdkappid:' + sdkappid + '\n' +
    'TLS.time:' + currTime + '\n' +
    'TLS.expire:' + expire + '\n';
  const sig = crypto.createHmac('sha256', key).update(contentToBeSigned).digest('base64');

  const sigDoc = {
    'TLS.ver': '2.0',
    'TLS.identifier': '' + userid,
    'TLS.sdkappid': Number(sdkappid),
    'TLS.time': Number(currTime),
    'TLS.expire': Number(expire),
    'TLS.sig': sig
  };
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(sigDoc))).toString('base64');
  return base64urlEscape(compressed);
}

module.exports = async function (req, res) {
  const userId = (req.query && req.query.userId || '').trim();
  if (!userId) { res.status(400).json({ error: 'missing userId' }); return; }

  const sdkAppID = parseInt(process.env.TIM_SDKAPPID, 10);
  const secretKey = process.env.TIM_SECRETKEY;
  if (!sdkAppID || !secretKey) {
    res.status(500).json({ error: 'TIM env not configured (TIM_SDKAPPID / TIM_SECRETKEY)' });
    return;
  }
  try {
    const userSig = genUserSig(sdkAppID, secretKey, userId, 86400 * 60); // 有效期 60 天
    res.json({ userSig: userSig });
  } catch (e) {
    console.error('[genUserSig]', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
