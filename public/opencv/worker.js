/**
 * OpenCV 模板匹配 Worker（经典 Worker，非 module）。
 *
 * 通过 importScripts 加载 opencv.js（UMD 格式），
 * 接收 {id, search: ImageData, template: ImageData, useMask: boolean}，
 * 返回 {id, x, y, maxVal} / {id, uniform} / {id, maskUnsupported} / {id, error}。
 *
 * ⚠️ 关于 mask：拼图块常常是带透明形状的（凸起的拼图轮廓）。不带 mask 匹配时
 * 透明像素在 RGBA 里是 (0,0,0,0)，OpenCV 会把它们当成**黑色实心像素**参与
 * 相关计算 —— 匹配结果必然偏。所以形状模板必须用 alpha 通道当 mask。
 *
 * OpenCV 官方文档对 matchTemplate 的 mask 参数写明「Currently, only the
 * TM_SQDIFF and TM_CCORR_NORMED methods are supported」。部分 4.x 构建其实
 * 也接受 TM_CCOEFF_NORMED + mask，但不能假定。因此这里先试 CCOEFF_NORMED
 * （置信度与调用方的阈值同一量纲），失败则如实回报 maskUnsupported，
 * 由调用方改走 JS 的 alpha 感知 NCC —— 绝不拿一个不同量纲的分数冒充。
 */

let cv = null;

try {
  importScripts('./opencv.js');
  cv = self.cv;

  if (typeof cv === 'function') {
    cv = cv();
  }
} catch (_err) {
  // opencv.js 加载失败
}

if (cv && cv.Mat && cv.matchTemplate) {
  postMessage('ready');
} else {
  postMessage('error');
}

/** 是否支持带 mask 的 TM_CCOEFF_NORMED。null 表示还没探测过。 */
let maskedCcoeffSupported = null;

/**
 * 用模板 alpha 通道构造二值 mask。
 *
 * 返回 null 表示 alpha 里没有足够的有效/无效像素区分度 —— 那说明模板其实是
 * 不透明矩形，用 mask 没有意义。
 */
function buildAlphaMask(template) {
  const total = template.width * template.height;
  const mask = new cv.Mat(template.height, template.width, cv.CV_8UC1);
  let opaque = 0;
  for (let i = 0; i < total; i++) {
    const on = template.data[i * 4 + 3] >= 32 ? 255 : 0;
    mask.data[i] = on;
    if (on) opaque++;
  }
  const ratio = opaque / total;
  if (ratio < 0.05 || ratio > 0.97) {
    mask.delete();
    return null;
  }
  return mask;
}

self.onmessage = async (e) => {
  if (!cv) {
    postMessage({ id: e.data.id, error: 'OpenCV 未加载' });
    return;
  }

  const { id, search, template, useMask } = e.data;
  const disposables = [];
  const cleanup = () => {
    for (const mat of disposables) {
      try { mat.delete(); } catch (_err) { /* 已释放 */ }
    }
    disposables.length = 0;
  };

  try {
    const src = cv.matFromImageData(search);
    disposables.push(src);
    const templ = cv.matFromImageData(template);
    disposables.push(templ);

    // TM_CCOEFF_NORMED 对常量模板数学上无定义（模板标准差为 0），
    // 结果会变成 NaN。滑块拼图块经常是纯色图形，因此通知 background
    // 改走 JS 的均匀模板匹配路径。
    const templateData = template.data;
    let templateSum = 0;
    let templateSqSum = 0;
    let templateValid = 0;
    const templateLength = template.width * template.height;
    for (let i = 0; i < templateLength; i++) {
      const p = i * 4;
      if (templateData[p + 3] < 128) continue;
      const gray = 0.299 * templateData[p]
        + 0.587 * templateData[p + 1]
        + 0.114 * templateData[p + 2];
      templateSum += gray;
      templateSqSum += gray * gray;
      templateValid++;
    }
    if (templateValid === 0) {
      cleanup();
      postMessage({ id, error: '模板没有有效像素' });
      return;
    }
    const templateMean = templateSum / templateValid;
    const templateVar = Math.max(0, templateSqSum / templateValid - templateMean * templateMean);
    if (Math.sqrt(templateVar) < 1) {
      cleanup();
      postMessage({ id, uniform: true });
      return;
    }

    let alphaMask = null;
    if (useMask) {
      alphaMask = buildAlphaMask(template);
      if (!alphaMask) {
        // alpha 没有区分度，等于不透明矩形，按普通路径处理即可。
        alphaMask = null;
      } else {
        disposables.push(alphaMask);
      }
    }

    /*
     * 形状模板 + 本构建不支持 masked CCOEFF_NORMED 时必须退出。
     *
     * 继续跑无 mask 的匹配会把透明区域当黑色实心，给出一个看起来正常、
     * 实际错位的结果 —— 那比没有结果更糟，因为调用方会把它当成一路有效
     * 候选去参与融合。
     */
    if (alphaMask && maskedCcoeffSupported === false) {
      cleanup();
      postMessage({ id, maskUnsupported: true });
      return;
    }

    const dst = new cv.Mat();
    disposables.push(dst);

    if (alphaMask) {
      try {
        cv.matchTemplate(src, templ, dst, cv.TM_CCOEFF_NORMED, alphaMask);
        maskedCcoeffSupported = true;
      } catch (maskError) {
        maskedCcoeffSupported = false;
        cleanup();
        postMessage({ id, maskUnsupported: true });
        return;
      }
    } else {
      // 无 mask 路径：传空 Mat 即"不使用 mask"，与原行为一致。
      const empty = new cv.Mat();
      disposables.push(empty);
      cv.matchTemplate(src, templ, dst, cv.TM_CCOEFF_NORMED, empty);
    }

    const result = cv.minMaxLoc(dst);
    const maxVal = result.maxVal;
    const maxLoc = result.maxLoc;
    cleanup();

    if (!Number.isFinite(maxVal)) {
      postMessage({ id, error: '匹配结果不是有限值' });
      return;
    }
    postMessage({ id, x: maxLoc.x, y: maxLoc.y, maxVal, masked: !!alphaMask });
  } catch (err) {
    cleanup();
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
