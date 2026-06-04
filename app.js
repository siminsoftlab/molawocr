const pdfInput = document.getElementById("pdfInput");
const output = document.getElementById("output");

pdfInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    output.textContent = "PDF 로딩 중...";

    const pdfData = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;

    let fullText = "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        output.textContent = `페이지 ${pageNum}/${pdf.numPages} 처리 중...`;

        const page = await pdf.getPage(pageNum);

        // 🔥 고해상도 렌더링 (scale 4)
        const viewport = page.getViewport({ scale: 4 });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;

        // 🔥 이미지 전처리 (흑백 + 대비 강화)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const avg = (data[i] + data[i+1] + data[i+2]) / 3;
            const value = avg > 140 ? 255 : 0; // threshold
            data[i] = data[i+1] = data[i+2] = value;
        }

        ctx.putImageData(imageData, 0, 0);

        const imageUrl = canvas.toDataURL("image/png");

        // 🔥 Tesseract 고급 옵션 적용
        const result = await Tesseract.recognize(imageUrl, "kor+eng", {
            logger: (m) => console.log(m),
            tessedit_pageseg_mode: 6, // 단락 분석 강화
            tessedit_char_blacklist: "!@#$%^&*()[]{}<>~`"
        });

        fullText += `\n\n=== PAGE ${pageNum} ===\n`;
        fullText += result.data.text;
    }

    output.textContent = fullText;
});
