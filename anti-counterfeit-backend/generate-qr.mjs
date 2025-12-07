import QRCode from "qrcode";

// 👇 After running generate-token.js, copy the printed token into this variable
const signedToken = "PASTE_SIGNED_TOKEN_HERE";

const verifyUrl = `https://verify.myproductauth.com/verify.html?p=${encodeURIComponent(
  signedToken
)}`;

QRCode.toFile("product-qr.png", verifyUrl, { width: 1200 })
  .then(() => {
    console.log("✅ QR code saved as product-qr.png");
    console.log("URL inside QR:");
    console.log(verifyUrl);
  })
  .catch((err) => {
    console.error("QR generation error:", err);
  });

