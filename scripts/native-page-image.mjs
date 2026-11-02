import { createCanvas, ImageData } from "@napi-rs/canvas";

export const MAX_PAGE_EDGE = 2400;
export const MAX_PAGE_PIXELS = 6_000_000;

function close(left, right) {
  return Math.abs(left - right) <= 1e-7 * Math.max(1, Math.abs(left), Math.abs(right));
}

function transform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

// Only a single, upright image covering the complete page can bypass PDF
// rasterization. Any drawing, clipping, graphics state, or annotation falls back
// to the regular renderer so extracting a scan cannot discard visible content.
function findPageImage(page, operators, OPS) {
  const view = page.view;
  if (page.rotate !== 0 || page.userUnit !== 1 || !Array.isArray(view) || view.length !== 4 || !view.every(Number.isFinite)) return null;
  const [left, bottom, right, top] = view;
  if (right <= left || top <= bottom || operators.fnArray.length > 1000) return null;
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let image = null;
  for (let index = 0; index < operators.fnArray.length; index++) {
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operation === OPS.save) {
      if (stack.length >= 64) return null;
      stack.push(matrix);
    } else if (operation === OPS.restore) {
      if (!stack.length) return null;
      matrix = stack.pop();
    } else if (operation === OPS.transform) {
      if (!Array.isArray(args) || args.length !== 6 || !args.every(Number.isFinite)) return null;
      matrix = transform(matrix, args);
      if (!matrix.every(Number.isFinite)) return null;
    } else if (operation === OPS.paintImageXObject) {
      if (image || typeof args?.[0] !== "string") return null;
      const [width, skewY, skewX, height, x, y] = matrix;
      if (width <= 0 || height <= 0 || !close(skewX, 0) || !close(skewY, 0)
        || !close(x, left) || !close(y, bottom) || !close(width, right - left) || !close(height, top - bottom)) return null;
      image = { id: args[0], width: args[1], height: args[2], pageWidth: width, pageHeight: height };
    } else if (operation !== OPS.dependency) {
      return null;
    }
  }
  return stack.length === 0 ? image : null;
}

function getImage(page, id) {
  const objects = id.startsWith("g_") ? page.commonObjs : page.objs;
  if (objects.has(id)) return Promise.resolve(objects.get(id));
  // getOperatorList can finish before its decoded image arrives. Avoid making
  // an optional optimization wait indefinitely for an unresolved dependency.
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 1000);
    objects.get(id, image => {
      clearTimeout(timeout);
      resolve(image);
    });
  });
}

export async function renderNativePageImage(page, { OPS, ImageKind }) {
  try {
    const candidate = findPageImage(page, await page.getOperatorList(), OPS);
    if (!candidate) return null;
    const image = await getImage(page, candidate.id);
    if (!image) return null;
    const { width, height, kind, data } = image;
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_PAGE_EDGE)
      || width * height > MAX_PAGE_PIXELS || width !== candidate.width || height !== candidate.height
      || !close(candidate.pageWidth / width, candidate.pageHeight / height)
      || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
    const channels = kind === ImageKind.RGB_24BPP ? 3 : kind === ImageKind.RGBA_32BPP ? 4 : 0;
    if (!channels || data.length !== width * height * channels) return null;
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (channels === 4) {
      rgba.set(data);
    } else {
      for (let source = 0, target = 0; source < data.length; source += 3, target += 4) {
        rgba[target] = data[source];
        rgba[target + 1] = data[source + 1];
        rgba[target + 2] = data[source + 2];
        rgba[target + 3] = 255;
      }
    }
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    // Preserve the normal renderer's white page behind transparent PNG pixels.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    return canvas;
  } catch {
    // Inspection is an optimization; unsupported PDFs still use page.render.
    return null;
  }
}
