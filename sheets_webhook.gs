// Google Sheets webhook for the audio QC checker.
// Paste into the Sheet: Extensions > Apps Script. Deploy as a web app.
// qc.py sends three tables (Runs, Files, Rules); this appends them and keeps them readable.

const FORMAT = {
  Runs:  {percent: [6], counts: [4, 5], rate: 6, widths: {2: 160, 8: 260}},
  Files: {percent: [11], result: 3, wrap: 4, reasons: 4, widths: {2: 380, 4: 320}},
  Rules: {widths: {2: 160, 3: 200}},
};
const GROUPS = [  // text colour per kind of problem, matched on words in each reason
  ['#6a1b9a', ['type', 'sample rate', 'bit depth', 'bitrate', 'channels']],  // purple: format
  ['#1565c0', ['too short', 'too long']],                                     // blue: length
  ['#bf360c', ['too quiet', 'too loud', 'full scale']],                       // orange: level
  ['#00796b', ['silent', 'bandwidth']],                                       // teal: content
];
const LEGEND = 'Colours: purple = format (type, sample rate, bit depth, bitrate, channels); ' +
  'blue = length; orange = level (quiet, loud, clipping); teal = content (silence, bandwidth).';

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const book = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of ['Runs', 'Files', 'Rules']) {
    const {headers, rows} = data[name];
    const sheet = book.getSheetByName(name) || setUp(book, name, headers);
    if (rows.length) {
      const first = sheet.getLastRow() + 1;
      if (sheet.getMaxRows() < first + rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length);
      sheet.getRange(first, 1, rows.length, headers.length).setValues(rows);
      const f = FORMAT[name];
      (f.percent || []).forEach(c => sheet.getRange(first, c, rows.length).setNumberFormat('0%'));
      if (f.wrap) sheet.getRange(first, f.wrap, rows.length).setWrap(true);
      if (f.result) colourResults(sheet, f.result);
      if (f.reasons) {
        colourReasons(sheet.getRange(first, f.reasons, rows.length));
        sheet.getRange(1, f.reasons).setRichTextValue(legendHeader()).setNote(LEGEND);
      }
      if (f.rate) colourRuns(sheet, f.counts, f.rate);
    }
    if (sheet.getFilter()) sheet.getFilter().remove();  // re-apply so the filter covers the new rows
    sheet.getDataRange().createFilter();
  }
  const blank = book.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) book.deleteSheet(blank);
  return ContentService.createTextOutput('ok');
}

function setUp(book, name, headers) {
  const sheet = book.insertSheet(name);
  const f = FORMAT[name];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8eaed').setWrap(true);
  sheet.setFrozenRows(1);
  for (const [col, px] of Object.entries(f.widths || {})) sheet.setColumnWidth(Number(col), px);
  return sheet;
}

function colourResults(sheet, col) {  // green PASS, red FLAG, over the whole column as it grows
  const column = sheet.getRange(2, col, sheet.getMaxRows() - 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('PASS')
      .setBackground('#d9f2e3').setFontColor('#137333').setRanges([column]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('FLAG')
      .setBackground('#fce8e6').setFontColor('#a50e0e').setRanges([column]).build(),
  ]);
}

function colourReasons(range) {  // each reason in the cell gets its group's colour
  range.setRichTextValues(range.getValues().map(([value]) => {
    const text = String(value);
    const builder = SpreadsheetApp.newRichTextValue().setText(text);
    let start = 0;
    for (const reason of text.split('; ')) {
      const group = GROUPS.find(([, words]) => words.some(word => reason.includes(word)));
      if (group) {
        builder.setTextStyle(start, start + reason.length,
          SpreadsheetApp.newTextStyle().setForegroundColor(group[0]).setBold(true).build());
      }
      start += reason.length + 2;  // skip the "; " between reasons
    }
    return [builder.build()];
  }));
}

function legendHeader() {  // "Why flagged" plus the colour key, visible in the header row
  const names = ['format', 'length', 'level', 'content'];
  const title = 'Why flagged\n';
  const builder = SpreadsheetApp.newRichTextValue().setText(title + names.join('  '));
  let start = title.length;
  names.forEach((name, i) => {
    builder.setTextStyle(start, start + name.length,
      SpreadsheetApp.newTextStyle().setForegroundColor(GROUPS[i][0]).setBold(true).build());
    start += name.length + 2;
  });
  return builder.build();
}

function colourRuns(sheet, [passedCol, flaggedCol], rateCol) {  // green passed, red flagged, rate by 50%
  const column = col => sheet.getRange(2, col, sheet.getMaxRows() - 1);
  const rule = () => SpreadsheetApp.newConditionalFormatRule();
  sheet.setConditionalFormatRules([
    rule().whenCellNotEmpty().setBackground('#d9f2e3').setFontColor('#137333').setRanges([column(passedCol)]).build(),
    rule().whenCellNotEmpty().setBackground('#fce8e6').setFontColor('#a50e0e').setRanges([column(flaggedCol)]).build(),
    rule().whenNumberLessThan(0.5).setBackground('#fce8e6').setFontColor('#a50e0e').setRanges([column(rateCol)]).build(),
    rule().whenNumberGreaterThanOrEqualTo(0.5).setBackground('#d9f2e3').setFontColor('#137333').setRanges([column(rateCol)]).build(),
  ]);
}
