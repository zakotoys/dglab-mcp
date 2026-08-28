import QRCode from "qrcode";

/** Render a pairing link as a PNG QR code for the DG-LAB 4 app. */
export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
  });
}
