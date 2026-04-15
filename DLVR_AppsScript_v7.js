// ══════════════════════════════════════════════════════════════
//  DLVR Invoice Processor v7 — Fast POST + Background Analysis
// ══════════════════════════════════════════════════════════════

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  API_KEY:      'YOUR_API_KEY_HERE',   // ← مفتاح Claude API
  MODEL:        'claude-haiku-4-5-20251001',
  FOLDER:       'DLVR_Invoices',
  SHEET:        'الفواتير',
};

// ── COLUMNS ──────────────────────────────────────────────────
const COLS = ['التاريخ','الوقت','رمز الفرع','اسم الفرع','رقم الطلب','رقم الطلب الخارجي','المنصة','عدد الأصناف','المبلغ','الضريبة','الإجمالي','حالة الدفع','نوع الطلب','رابط الصورة','الحالة'];

// ══════════════════════════════════════════════════════════════
//  1) doPost — FAST (saves image + raw row, returns immediately)
// ══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.action !== 'processInvoice') {
      return _json({ error: 'Unknown action' });
    }

    const now = new Date();
    const date = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const time = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss');

    // Upload image to Drive (fast)
    let imageUrl = '';
    if (d.imageBase64) {
      imageUrl = _uploadImage(d.imageBase64, d.branchCode || '0000');
    }

    // Write raw row immediately (no Claude call yet)
    const row = [
      date, time,
      d.branchCode || '', d.branchLabel || '',
      '', '', '', 0, 0, 0, 0, '', '',
      imageUrl,
      'pending'  // ← column O = status
    ];
    _getSheet().appendRow(row);

    return _json({ success: true, status: 'pending', imageUrl: imageUrl });

  } catch (err) {
    return _json({ error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
//  2) processQueue — BACKGROUND (runs every minute via trigger)
// ══════════════════════════════════════════════════════════════
function processQueue() {
  const sheet = _getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const statusCol = 15; // Column O
  const data = sheet.getRange(2, 1, lastRow - 1, 15).getValues();

  for (let i = 0; i < data.length; i++) {
    if (data[i][14] !== 'pending') continue;

    const rowNum = i + 2;
    const imageUrl = data[i][13]; // Column N

    try {
      // Mark as processing
      sheet.getRange(rowNum, statusCol).setValue('processing');

      // Call Claude API
      const result = _analyzeImage(imageUrl);

      // Update row with analysis results
      sheet.getRange(rowNum, 5).setValue(result.orderNumber || '');       // E
      sheet.getRange(rowNum, 6).setValue(result.externalOrderNumber || '');// F
      sheet.getRange(rowNum, 7).setValue(result.platform || '');          // G
      sheet.getRange(rowNum, 8).setValue(result.itemCount || 0);         // H
      sheet.getRange(rowNum, 9).setValue(result.subtotal || 0);          // I
      sheet.getRange(rowNum, 10).setValue(result.tax || 0);              // J
      sheet.getRange(rowNum, 11).setValue(result.total || 0);            // K
      sheet.getRange(rowNum, 12).setValue(result.paymentStatus || '');   // L
      sheet.getRange(rowNum, 13).setValue(result.orderType || '');       // M
      sheet.getRange(rowNum, statusCol).setValue('done');

    } catch (err) {
      sheet.getRange(rowNum, statusCol).setValue('error: ' + err.message.substring(0, 50));
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  3) Claude API — Analyze image from Drive URL
// ══════════════════════════════════════════════════════════════
function _analyzeImage(imageUrl) {
  // Download image from Drive and convert to base64
  const fileId = imageUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!fileId) throw new Error('رابط صورة غير صالح');

  const file = DriveApp.getFileById(fileId[1]);
  const blob = file.getBlob();
  const b64 = Utilities.base64Encode(blob.getBytes());

  const prompt = `حلل فاتورة المطعم هذه. أجب بـ JSON فقط:
{"orderNumber":"","externalOrderNumber":"","platform":"","itemCount":0,"subtotal":0,"tax":0,"total":0,"paymentStatus":"","orderType":""}

قواعد:
1. orderNumber = رقم المنصة الطويل (9-11 رقم) من "External Order Id" أو بجانب اسم المنصة. تجاهل الأرقام القصيرة (3-4 أرقام)
2. externalOrderNumber = الرقم البارز الكبير في أعلى الفاتورة
3. platform = من "Channel Name:" — حوّل للعربية: HUNGER_STATION=هنقرستيشن, JAHEZ=جاهز, MARSOOL=مرسول, TOYO=تويو, CAREEM=كريم, SHGARDI=شقردي, THE_CHEFZ=ذا شفز, WSSEL=وصّل, KEETA=كيتا
4. أرقام فقط بدون عملة. إذا مالقيت معلومة: "" أو 0`;

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': CONFIG.API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: prompt }
      ]}]
    }),
    muteHttpExceptions: true
  });

  const body = JSON.parse(res.getContentText());
  if (body.error) throw new Error(body.error.message);

  const text = body.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('فشل تحليل الرد');
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════════════════════════
//  4) Upload Image to Drive
// ══════════════════════════════════════════════════════════════
function _uploadImage(b64, branchCode) {
  const folder = _getFolder(CONFIG.FOLDER);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const sub = _getSubFolder(folder, today);

  const file = sub.createFile(
    Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', branchCode + '_' + Date.now() + '.jpg')
  );
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?id=' + file.getId();
}

// ══════════════════════════════════════════════════════════════
//  5) SETUP — Run once to create sheet + trigger
// ══════════════════════════════════════════════════════════════
function setupDLVR() {
  // Create or get sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET);

  // Write headers if empty
  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, COLS.length).setValues([COLS]);
    sheet.getRange(1, 1, 1, COLS.length).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
  }

  // Create Drive folder
  _getFolder(CONFIG.FOLDER);

  SpreadsheetApp.getUi().alert('✅ تم التجهيز!\n\nالخطوة التالية:\n1. شغّل createTrigger()\n2. انشر كـ Web App');
}

// ══════════════════════════════════════════════════════════════
//  6) CREATE TRIGGER — sets up 1-minute background processing
// ══════════════════════════════════════════════════════════════
function createTrigger() {
  // Delete old triggers
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });

  // Create new 1-minute trigger
  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .everyMinutes(1)
    .create();

  SpreadsheetApp.getUi().alert('✅ تم إنشاء الـ Trigger!\n\nprocessQueue() بيشتغل كل دقيقة تلقائياً');
}

// ══════════════════════════════════════════════════════════════
//  7) TEST — Test Claude API connection
// ══════════════════════════════════════════════════════════════
function testAPI() {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': CONFIG.API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'قل: مرحبا DLVR' }]
    }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (body.error) {
    SpreadsheetApp.getUi().alert('❌ خطأ:\n' + body.error.message);
  } else {
    SpreadsheetApp.getUi().alert('✅ يعمل!\n\n' + body.content[0].text);
  }
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(CONFIG.SHEET);
  if (!s) { s = ss.insertSheet(CONFIG.SHEET); s.getRange(1,1,1,COLS.length).setValues([COLS]).setFontWeight('bold'); s.setFrozenRows(1); }
  return s;
}

function _getFolder(name) {
  const f = DriveApp.getFoldersByName(name);
  return f.hasNext() ? f.next() : DriveApp.createFolder(name);
}

function _getSubFolder(parent, name) {
  const f = parent.getFoldersByName(name);
  return f.hasNext() ? f.next() : parent.createFolder(name);
}
