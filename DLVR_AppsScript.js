// ══════════════════════════════════════════════════════════════
//  DLVR Invoice Processor — Google Apps Script
//  v6 — Uses Claude API for invoice analysis + Google Drive for images
// ══════════════════════════════════════════════════════════════

// ── CONFIG (غيّر هذي القيم) ──────────────────────────────────
const CONFIG = {
  CLAUDE_API_KEY: 'sk-ant-XXXXXXXX',           // ← ضع مفتاح Claude API هنا
  CLAUDE_MODEL:   'claude-haiku-4-5-20251001',  // موديل سريع ورخيص للتحليل
  DRIVE_FOLDER:   'DLVR_Invoices',              // اسم المجلد في Google Drive
  SHEET_NAME:     'الفواتير',                     // اسم الشيت
};

// ── أسماء الأعمدة ────────────────────────────────────────────
const COLUMNS = [
  'التاريخ',           // A
  'الوقت',            // B
  'رمز الفرع',        // C
  'اسم الفرع',        // D
  'رقم الطلب',        // E
  'رقم الطلب الخارجي', // F
  'المنصة',           // G
  'عدد الأصناف',      // H
  'المبلغ',           // I
  'الضريبة',          // J
  'الإجمالي',         // K
  'حالة الدفع',       // L
  'نوع الطلب',        // M
  'رابط الصورة',      // N
];

// ══════════════════════════════════════════════════════════════
//  ENTRY POINT — POST handler
// ══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'processInvoice') {
      const result = processInvoice(data);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ══════════════════════════════════════════════════════════════
//  PROCESS INVOICE
// ══════════════════════════════════════════════════════════════
function processInvoice(data) {
  const { branchCode, branchLabel, imageBase64 } = data;

  if (!imageBase64) throw new Error('لا توجد صورة');

  // 1) رفع الصورة على Google Drive
  const imageUrl = uploadImageToDrive(imageBase64, branchCode);

  // 2) تحليل الفاتورة عبر Claude API
  const invoiceData = analyzeInvoiceWithClaude(imageBase64);

  // 3) كتابة البيانات في الشيت
  const now = new Date();
  const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');

  const row = [
    dateStr,                              // التاريخ
    timeStr,                              // الوقت
    branchCode,                           // رمز الفرع
    branchLabel,                          // اسم الفرع
    invoiceData.orderNumber || '',        // رقم الطلب
    invoiceData.externalOrderNumber || '',// رقم الطلب الخارجي
    invoiceData.platform || '',           // المنصة
    invoiceData.itemCount || 0,           // عدد الأصناف
    invoiceData.subtotal || 0,            // المبلغ
    invoiceData.tax || 0,                 // الضريبة
    invoiceData.total || 0,              // الإجمالي
    invoiceData.paymentStatus || '',      // حالة الدفع
    invoiceData.orderType || '',          // نوع الطلب
    imageUrl,                             // رابط الصورة
  ];

  writeToSheet(row);

  return {
    success: true,
    orderNumber: invoiceData.orderNumber,
    total: invoiceData.total,
    imageUrl: imageUrl,
  };
}

// ══════════════════════════════════════════════════════════════
//  UPLOAD IMAGE TO GOOGLE DRIVE
// ══════════════════════════════════════════════════════════════
function uploadImageToDrive(base64Data, branchCode) {
  // البحث عن المجلد أو إنشائه
  const folder = getOrCreateFolder(CONFIG.DRIVE_FOLDER);

  // إنشاء مجلد فرعي بتاريخ اليوم
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const dayFolder = getOrCreateSubFolder(folder, today);

  // حفظ الصورة
  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64Data),
    'image/jpeg',
    `${branchCode}_${Date.now()}.jpg`
  );

  const file = dayFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return `https://drive.google.com/uc?id=${file.getId()}`;
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getOrCreateSubFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

// ══════════════════════════════════════════════════════════════
//  ANALYZE INVOICE WITH CLAUDE API
// ══════════════════════════════════════════════════════════════
function analyzeInvoiceWithClaude(base64Data) {
  const prompt = `أنت محلل فواتير متخصص. حلل هذه الفاتورة/الإيصال واستخرج المعلومات التالية بدقة.

أجب بصيغة JSON فقط بدون أي نص إضافي:
{
  "orderNumber": "رقم الطلب (Order #) - أرقام فقط",
  "externalOrderNumber": "رقم الطلب الخارجي إن وُجد، وإلا اتركه فارغ",
  "platform": "اسم المنصة/التطبيق (هنقرستيشن، جاهز، مرسول، تويو، كريم، شقردي، وغيرها) أو اسم المطعم",
  "itemCount": عدد الأصناف (رقم),
  "subtotal": المبلغ قبل الضريبة (رقم فقط بدون عملة),
  "tax": مبلغ الضريبة (رقم فقط، 0 إذا غير موجود),
  "total": الإجمالي الكلي (رقم فقط بدون عملة),
  "paymentStatus": "مدفوع أو غير مدفوع أو نقدي أو بطاقة",
  "orderType": "توصيل أو استلام أو محلي"
}

قواعد مهمة:
- إذا لم تجد معلومة معينة، اكتب "" للنصوص و 0 للأرقام
- الأرقام يجب أن تكون أرقام فقط بدون عملة أو رموز
- رقم الطلب عادة يكون بارز في أعلى الفاتورة
- ابحث عن المجموع الكلي (Total/الإجمالي) وليس المجموع الفرعي`;

  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const result = JSON.parse(response.getContentText());

  if (result.error) {
    throw new Error('Claude API: ' + (result.error.message || JSON.stringify(result.error)));
  }

  // استخراج JSON من الرد
  const text = result.content[0].text.trim();
  try {
    // محاولة parse مباشرة
    return JSON.parse(text);
  } catch {
    // محاولة استخراج JSON من بين النص
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('فشل تحليل رد Claude');
  }
}

// ══════════════════════════════════════════════════════════════
//  WRITE TO SHEET
// ══════════════════════════════════════════════════════════════
function writeToSheet(rowData) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  // إنشاء الشيت إذا غير موجود
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    setupSheetHeaders(sheet);
  }

  // التأكد من وجود الهيدر
  const firstCell = sheet.getRange(1, 1).getValue();
  if (!firstCell) {
    setupSheetHeaders(sheet);
  }

  // إضافة الصف
  sheet.appendRow(rowData);

  // تنسيق الصف الجديد
  const lastRow = sheet.getLastRow();
  formatDataRow(sheet, lastRow);
}

// ══════════════════════════════════════════════════════════════
//  SETUP SHEET — Headers + Formatting
// ══════════════════════════════════════════════════════════════
function setupSheetHeaders(sheet) {
  // كتابة الهيدر
  const headerRange = sheet.getRange(1, 1, 1, COLUMNS.length);
  headerRange.setValues([COLUMNS]);

  // تنسيق الهيدر
  headerRange
    .setBackground('#1a73e8')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  // ارتفاع صف الهيدر
  sheet.setRowHeight(1, 40);

  // عرض الأعمدة
  const widths = [100, 70, 80, 100, 110, 120, 100, 80, 90, 80, 90, 90, 80, 200];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // تجميد الصف الأول
  sheet.setFrozenRows(1);

  // فلتر
  sheet.getRange(1, 1, 1, COLUMNS.length).createFilter();
}

function formatDataRow(sheet, row) {
  const range = sheet.getRange(row, 1, 1, COLUMNS.length);
  range
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setFontSize(10);

  // تلوين متبادل للصفوف
  if (row % 2 === 0) {
    range.setBackground('#f8f9fa');
  }

  // تنسيق الأرقام
  sheet.getRange(row, 9).setNumberFormat('#,##0.00');  // المبلغ
  sheet.getRange(row, 10).setNumberFormat('#,##0.00'); // الضريبة
  sheet.getRange(row, 11).setNumberFormat('#,##0.00'); // الإجمالي

  // تحويل رابط الصورة إلى رابط قابل للنقر
  const urlCell = sheet.getRange(row, 14);
  const url = urlCell.getValue();
  if (url && url.startsWith('http')) {
    urlCell.setFormula(`=HYPERLINK("${url}","عرض الصورة")`);
    urlCell.setFontColor('#1a73e8');
  }
}

// ══════════════════════════════════════════════════════════════
//  SETUP — شغّل هذي مرة واحدة لتجهيز الشيت
// ══════════════════════════════════════════════════════════════
function setupDLVR() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (sheet) {
    // مسح البيانات القديمة (مع الاحتفاظ بالهيدر)
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    }
    setupSheetHeaders(sheet);
  } else {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    setupSheetHeaders(sheet);
  }

  // إنشاء مجلد الصور
  getOrCreateFolder(CONFIG.DRIVE_FOLDER);

  SpreadsheetApp.getUi().alert(
    'تم تجهيز DLVR بنجاح!\n\n' +
    '✅ شيت "الفواتير" جاهز\n' +
    '✅ مجلد "DLVR_Invoices" في Drive جاهز\n\n' +
    'الخطوة التالية:\n' +
    '1. ضع مفتاح Claude API في CONFIG\n' +
    '2. انشر كـ Web App (Deploy > New deployment)\n' +
    '3. اختر "Anyone" في Who has access'
  );
}

// ══════════════════════════════════════════════════════════════
//  TEST — لاختبار الاتصال بـ Claude API
// ══════════════════════════════════════════════════════════════
function testClaudeAPI() {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'قل: مرحبا DLVR' }]
    }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const result = JSON.parse(response.getContentText());

  if (result.error) {
    SpreadsheetApp.getUi().alert('❌ خطأ في API:\n' + result.error.message);
  } else {
    SpreadsheetApp.getUi().alert('✅ API يعمل!\n\nرد Claude: ' + result.content[0].text);
  }
}
