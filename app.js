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
        const viewport = page.getViewport({ scale: 2 });

        // Canvas 생성
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // PDF 페이지를 Canvas에 렌더링
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Canvas → 이미지 URL
        const imageUrl = canvas.toDataURL("image/png");

        // OCR 실행
        const result = await Tesseract.recognize(imageUrl, "kor+eng", {
            logger: (m) => console.log(m)
        });

        fullText += `\n\n=== PAGE ${pageNum} ===\n`;
        fullText += result.data.text;
    }

    output.textContent = fullText;
});
