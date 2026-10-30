// Google Sheets webhook for the audio QC checker.
// Paste into the Sheet: Extensions > Apps Script. Deploy as a web app.
// qc.py sends three tables (Runs, Files, Rules); this appends them and keeps them readable.
// Runs and Files start with a Run Number column, so a run can be found in both tabs.

const FORMAT = {  // column numbers count the Run Number column as column 1
  Runs:  {percent: [7], counts: [5, 6], rate: 7, widths: {3: 160, 9: 260}},
  Files: {percent: [12], result: 4, wrap: 5, reasons: 5, widths: {3: 380, 5: 320}},
  Rules: {widths: {2: 160, 3: 200}},
};
const GROUPS = [  // text colour per kind of problem, matched on words in each reason
  ['#6a1b9a', ['type', 'sample rate', 'bit depth', 'bitrate', 'channels']],  // purple: format
  ['#1565c0', ['too short', 'too long']],                                     // blue: length
  ['#bf360c', ['too quiet', 'too loud', 'full scale']],                       // orange: level
  ['#00796b', ['silent', 'bandwidth']],                                       // teal: content
];
const CELLS = {  // reason word -> Files column holding that value
  'type': 6, 'sample rate': 7, 'bit depth': 8, 'channels': 9, 'bitrate': 10, 'full scale': 14,
  'too short': 11, 'too long': 11, 'silent': 12, 'too quiet': 15, 'too loud': 15, 'bandwidth': 16,
};
const RUN_HEADERS = ['Run #', 'Run Number'];  // old and new name of column A
const LEGEND = 'Colours: purple = format (type, sample rate, bit depth, bitrate, channels); ' +
  'blue = length; orange = level (quiet, loud, clipping); teal = content (silence, bandwidth).';

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const runsSheet = book.getSheetByName('Runs');
  const number = runsSheet ? runsSheet.getLastRow() : 1;  // header is row 1, so this is runs so far + 1
  for (const name of ['Runs', 'Files', 'Rules']) {
    let {headers, rows} = data[name];
    if (name !== 'Rules') {
      headers = ['Run Number', ...headers];
      rows = rows.map(row => [number, ...row]);
    }
    const sheet = book.getSheetByName(name) || setUp(book, name, headers);
    if (rows.length) {
      if (name === 'Files') addRun(sheet, rows, headers.length);
      else writeRows(sheet, name, sheet.getLastRow() + 1, rows, headers.length);
    }
    if (sheet.getFilter()) sheet.getFilter().remove();  // re-apply so the filter covers the new rows
    sheet.getDataRange().createFilter();
  }
  const blank = book.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) book.deleteSheet(blank);
  return ContentService.createTextOutput('ok');
}

function writeRows(sheet, name, first, rows, width) {  // values plus this table's formatting
  if (sheet.getMaxRows() < first + rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1);
  const range = sheet.getRange(first, 1, rows.length, width);
  range.setValues(rows).setFontWeight('normal').setBackground(null);
  if (name !== 'Rules') sheet.getRange(first, 1, rows.length).setNumberFormat('0');  // 1, 2, 3, not dates
  const f = FORMAT[name];
  (f.percent || []).forEach(c => sheet.getRange(first, c, rows.length).setNumberFormat('0%'));
  if (f.wrap) sheet.getRange(first, f.wrap, rows.length).setWrap(true);
  if (f.result) colourResults(sheet, f.result);
  if (f.reasons) {
    colourReasons(sheet.getRange(first, f.reasons, rows.length));
    colourCells(sheet, first, rows);
    sheet.getRange(1, f.reasons).setRichTextValue(legendHeader()).setNote(LEGEND);
  }
  if (f.rate) colourRuns(sheet, f.counts, f.rate);
  return range;
}

function addRun(sheet, rows, width) {  // one grey summary row per run, its files folded underneath
  const first = sheet.getLastRow() + 1;
  if (sheet.getMaxRows() < first + rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 2);
  const passed = rows.filter(row => row[3] === 'PASS').length;
  const title = [rows[0][0], rows[0][1], `${rows.length} files: ${passed} passed, ${rows.length - passed} flagged`];
  sheet.getRange(first, 1, 1, width).setValues([title.concat(Array(width - 3).fill(''))])
    .setFontWeight('bold').setBackground('#e8eaed');
  sheet.getRange(first, 1).setNumberFormat('0');
  const body = writeRows(sheet, 'Files', first + 1, rows, width);
  sheet.setRowGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
  body.shiftRowGroupDepth(1);
  sheet.collapseAllRowGroups();  // older runs fold away, the newest stays open
  sheet.getRowGroup(first + 1, 1).expand();
}

function upgradeSheet() {  // run by hand: numbers past runs, rebuilds Files grouped by run, removes Files (old)
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const runsSheet = book.getSheetByName('Runs');
  const count = runsSheet.getLastRow() - 1;
  if (!RUN_HEADERS.includes(runsSheet.getRange(1, 1).getValue())) {
    runsSheet.insertColumnBefore(1);
    runsSheet.getRange(2, 1, count).setValues(Array.from({length: count}, (_, i) => [i + 1]))
      .setFontWeight('normal').setBackground(null);
  }
  runsSheet.getRange(1, 1).setValue('Run Number').setFontWeight('bold').setBackground('#e8eaed');
  runsSheet.getRange(2, 1, runsSheet.getMaxRows() - 1).setNumberFormat('0');  // 1, 2, 3, not dates
  if (runsSheet.getFilter()) runsSheet.getFilter().remove();
  runsSheet.getDataRange().createFilter();
  const numbers = new Map(runsSheet.getRange(2, 1, count, 2).getValues()
    .map(([number, time]) => [String(time), number]));

  let old = book.getSheetByName('Files (old)');  // left over from a run that stopped halfway
  if (old) {
    const partial = book.getSheetByName('Files');
    if (partial) book.deleteSheet(partial);
  } else {
    old = book.getSheetByName('Files');
    old.setName('Files (old)');
  }
  const headers = old.getRange(1, 1, 1, old.getLastColumn()).getValues()[0];
  const numbered = RUN_HEADERS.includes(headers[0]);
  if (numbered) headers.shift();
  headers.unshift('Run Number');
  headers[4] = 'Why flagged';
  const runs = new Map();
  for (const row of old.getRange(2, 1, old.getLastRow() - 1, old.getLastColumn()).getValues()) {
    const values = numbered ? row.slice(1) : row;
    if (values[2] !== 'PASS' && values[2] !== 'FLAG') continue;  // skip summary rows
    const time = String(values[0]);
    if (!runs.has(time)) runs.set(time, []);
    runs.get(time).push([numbers.get(time) ?? '', ...values]);
  }
  const sheet = setUp(book, 'Files', headers);
  book.setActiveSheet(sheet);
  book.moveActiveSheet(old.getIndex());
  for (const rows of runs.values()) addRun(sheet, rows, headers.length);
  sheet.getDataRange().createFilter();
  book.deleteSheet(old);
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

function colourCells(sheet, first, rows) {  // out-of-spec value cell: light red, text in its group's colour
  rows.forEach((row, i) => {
    for (const reason of String(row[4]).split('; ')) {
      const word = Object.keys(CELLS).find(w => reason.includes(w));
      if (!word) continue;
      const [colour] = GROUPS.find(([, words]) => words.includes(word));
      sheet.getRange(first + i, CELLS[word])
        .setBackground('#fce8e6').setFontColor(colour).setFontWeight('bold');
    }
  });
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
