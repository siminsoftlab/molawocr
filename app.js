// =========================
// 기본 DOM 요소
// =========================
const logEl = document.getElementById('log');
const fileInput = document.getElementById('fileInput');
const runBtn = document.getElementById('runBtn');
const excelBtn = document.getElementById('excelBtn');
const debtTableBody = document.querySelector('#debtTable tbody');
const pdfCanvas = document.getElementById('pdfCanvas');
const pdfCtx = pdfCanvas.getContext('2d');

let chart; // Chart.js 그래프 저장용
window._debts = []; // 엑셀 다운로드용 전역 저장

// =========================
// 로그 출력
// =========================
function log(msg) {
  console.log(msg);
  logEl.textContent += msg + "\n";
}

// =========================
// OCR 실행 버튼
// =========================
runBtn.addEventListener('click', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    alert('PDF 또는 이미지 파일을 선택해 주세요.');
    return;
  }

  logEl.textContent = '';
  debtTableBody.innerHTML = '';
  log('파일 이름: ' + file.name);

  const ext = file.name.toLowerCase().split('.').pop();
  let fullText = '';

  try {
    if (ext === 'pdf') fullText = await ocrPdf(file);
    else fullText = await ocrImage(file);
  } catch (e) {
    log('OCR 오류: ' + e.message);
    return;
  }

  log("\n=== OCR 결과 일부 ===\n" + fullText.slice(0, 500));

  const debts = parseDebts(fullText);
  const flows = inferFlows(debts);

  // 흐름 정보 저장
  debts.forEach((d, i) => d.flow = flows.get(i) || "");

  window._debts = debts;

  renderDebtTable(debts);

  const totals = calculateTotals(debts);
  renderTotals(totals);
  renderChart(totals);

  log("\n부채 항목 수: " + debts.length);
});

// =========================
// 이미지 OCR
// =========================
async function ocrImage(file) {
  log('이미지 OCR 시작...');
  const url = URL.createObjectURL(file);
  const { data: { text } } = await Tesseract.recognize(url, 'kor+eng');
  URL.revokeObjectURL(url);
  log('이미지 OCR 완료');
  return text;
}

// =========================
// PDF OCR (고해상도 + 전처리)
// =========================
async function ocrPdf(file) {
  log('PDF OCR 시작...');
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    log(`페이지 ${pageNum} OCR 중...`);

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 3.5 }); // 🔥 고해상도

    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;

    await page.render({ canvasContext: pdfCtx, viewport }).promise;

    // 🔥 흑백 + 대비 강화
    const img = pdfCtx.getImageData(0, 0, pdfCanvas.width, pdfCanvas.height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i+1] + data[i+2]) / 3;
      const v = avg > 150 ? 255 : 0;
      data[i] = data[i+1] = data[i+2] = v;
    }
    pdfCtx.putImageData(img, 0, 0);

    const dataUrl = pdfCanvas.toDataURL("image/png");

    const { data: { text } } = await Tesseract.recognize(dataUrl, "kor+eng", {
      tessedit_pageseg_mode: 6,
      logger: m => log(`p${pageNum} 진행률: ${Math.round(m.progress * 100)}%`)
    });

    fullText += `\n=== PAGE ${pageNum} ===\n` + text;
  }

  return fullText;
}

// =========================
// 부채 자동 추출 알고리즘
// =========================
function parseDebts(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const debts = [];

  const typeKeywords = ['연 체', '연체', '대 지 급', '대지급', '공 공 정 보', '공공정보', '해 제'];

  for (const line of lines) {
    const hasType = typeKeywords.find(k => line.includes(k));
    if (!hasType) continue;

    const clean = line.replace(/\s+/g, ' ');

    const type = detectType(clean);
    if (!type) continue;

    const dates = clean.match(/\d{4}-\d{2}-\d{2}/g) || [];
    const numbers = clean.match(/\d{1,3}(?:,\d{3})+/g) || [];
    const codeMatch = clean.match(/\b\d{5}\b/);

    const code = codeMatch ? codeMatch[0] : '';
    const amount1 = numbers[0] ? numbers[0].replace(/,/g, '') : '';
    const amount2 = numbers[1] ? numbers[1].replace(/,/g, '') : '';

    let inst = clean;
    inst = inst.replace(type, '');
    if (code) inst = inst.replace(code, '');
    dates.forEach(d => inst = inst.replace(d, ''));
    numbers.forEach(n => inst = inst.replace(n, ''));
    inst = inst.replace(/[|,:]/g, '').trim();

    debts.push({
      raw: clean,
      type,
      institution: inst,
      code,
      date1: dates[0] || '',
      date2: dates[1] || '',
      amountRegistered: amount1,
      amountOverdue: amount2
    });
  }

  return debts;
}

function detectType(line) {
  if (line.includes('연 체') || line.includes('연체')) return '연체';
  if (line.includes('대 지 급') || line.includes('대지급')) return '대지급';
  if (line.includes('공 공 정 보') || line.includes('공공정보')) return '공공정보';
  if (line.includes('해 제')) return '해제';
  return null;
}

// =========================
// 흐름 추정 (연체 → 해제)
// =========================
function inferFlows(debts) {
  const flows = new Map();
  const byAmount = {};

  debts.forEach((d, idx) => {
    const key = d.amountRegistered;
    if (!key) return;
    if (!byAmount[key]) byAmount[key] = [];
    byAmount[key].push({ idx, d });
  });

  for (const key in byAmount) {
    const list = byAmount[key];
    const overdue = list.filter(x => x.d.type === '연체');
    const release = list.filter(x => x.d.type === '해제');

    overdue.forEach(o => {
      const r = release[0];
      if (r) {
        flows.set(o.idx, `${o.d.institution} → ${r.d.institution}`);
        flows.set(r.idx, `${o.d.institution} → ${r.d.institution} (해제)`);
      }
    });
  }

  return flows;
}

// =========================
// 부채 테이블 렌더링
// =========================
function renderDebtTable(debts) {
  debtTableBody.innerHTML = "";

  debts.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${d.type}</td>
      <td>${d.institution}</td>
      <td>${d.code}</td>
      <td>${d.date1}</td>
      <td>${d.date2}</td>
      <td>${Number(d.amountRegistered).toLocaleString()}</td>
      <td>${Number(d.amountOverdue).toLocaleString()}</td>
      <td>${d.flow || ''}</td>
      <td>${d.raw}</td>
    `;
    debtTableBody.appendChild(tr);
  });
}

// =========================
// 기관별 합계 계산
// =========================
function calculateTotals(debts) {
  const totals = {};

  debts.forEach(d => {
    const inst = d.institution || "기타";
    if (!totals[inst]) totals[inst] = { registered: 0, overdue: 0 };

    totals[inst].registered += Number(d.amountRegistered || 0);
    totals[inst].overdue += Number(d.amountOverdue || 0);
  });

  return totals;
}

// =========================
// 기관별 합계 테이블 렌더링
// =========================
function renderTotals(totals) {
  const tbody = document.querySelector("#sumTable tbody");
  tbody.innerHTML = "";

  Object.keys(totals).forEach(inst => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${inst}</td>
      <td>${totals[inst].registered.toLocaleString()}</td>
      <td>${totals[inst].overdue.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// =========================
// Chart.js 그래프
// =========================
function renderChart(totals) {
  const labels = Object.keys(totals);
  const registered = labels.map(k => totals[k].registered);
  const overdue = labels.map(k => totals[k].overdue);

  if (chart) chart.destroy();

  chart = new Chart(document.getElementById("chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "등록금액",
          data: registered,
          backgroundColor: "rgba(54, 162, 235, 0.6)"
        },
        {
          label: "연체금액",
          data: overdue,
          backgroundColor: "rgba(255, 99, 132, 0.6)"
        }
      ]
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true } }
    }
  });
}

// =========================
// 엑셀 다운로드
// =========================
excelBtn.addEventListener("click", () => {
  downloadExcel(window._debts || []);
});

function downloadExcel(debts) {
  const wsData = [
    ["유형", "기관명", "코드", "발생일", "해제일", "등록금액", "연체금액", "흐름", "원문"]
  ];

  debts.forEach(d => {
    wsData.push([
      d.type,
      d.institution,
      d.code,
      d.date1,
      d.date2,
      d.amountRegistered,
      d.amountOverdue,
      d.flow || "",
      d.raw
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "부채리스트");

  XLSX.writeFile(wb, "부채_분석.xlsx");
}
