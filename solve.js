// Fast drop-in for csv-reader 1.0.0.
//
// Reads one CSV text left to right and answers exactly as the reference
// does: {columns, rows, errors}. Same broken-row policy: a U+FEFF at the
// very start is dropped, a record ends at LF or CRLF, an empty line is no
// record, a CR outside quotes that is not followed by LF is dropped
// (stray_cr), a field that opens with a quote runs to the next quote that
// is not doubled ("" inside is one quote, CRLF or a lone CR inside is one
// LF), junk after the closing quote is appended as it stands (quote_junk),
// a quote that never closes is a literal and the rest is re-read as
// unquoted (unterminated_quote), a quote inside an unquoted field is a
// literal, fields stay strings, records are padded (short_row) or cut
// (long_row) to the first record's width.
//
// Speed comes from the shape of the scan, not from a different reading:
// unquoted fields are located with indexOf for the next comma or newline
// and sliced whole instead of built a character at a time, and quoted
// fields are located with indexOf for the next quote the same way. Only
// the rare paths (junk after a closing quote, a quote that never closes,
// a quoted segment holding a line break) fall back to a character loop.
// No dependencies, no state kept between calls.

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The line the record being read starts on, and its index in rows
  // (null for the header). Updated once per record; the slow reader below
  // reports its errors against the current record.
  let recLine = 1;
  let recRow = null;

  // Slow unquoted read, used only for the rare paths: the junk after a
  // closing quote and the re-read after a quote that never closes. It
  // follows the reference character by character: comma ends the field,
  // LF or CRLF ends the record, a lone CR is dropped with a stray_cr
  // error. Returns the field, how it ended (1 comma, 2 line break,
  // 3 end of text) and how many characters were kept.
  function readUnquotedSlow(value) {
    let added = 0;
    let ended = 3;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = 1;
        break;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = 2;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          ended = 2;
          break;
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return { value, ended, added };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = 1; // comma: enter the field loop
    let quoted = false;
    while (ended === 1) {
      let value = '';
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) {
        const open = pos;
        const openLine = line;
        let p = pos + 1;
        let closed = false;
        let unterminated = false;
        while (!closed) {
          const q = text.indexOf('"', p);
          if (q === -1) {
            unterminated = true;
            break;
          }
          // The stretch [p, q) holds no quote. When it holds no line
          // break either, it goes onto the value whole; otherwise each
          // CRLF or lone CR inside it becomes one LF and counts a line.
          let hasBreak = false;
          for (let i = p; i < q; i++) {
            const c = text.charCodeAt(i);
            if (c === 10 || c === 13) {
              hasBreak = true;
              break;
            }
          }
          if (hasBreak) {
            let s = p;
            for (let i = p; i < q; i++) {
              const c = text.charCodeAt(i);
              if (c === 13) {
                value += text.slice(s, i);
                value += '\n';
                line += 1;
                if (text.charCodeAt(i + 1) === 10) i += 1;
                s = i + 1;
              } else if (c === 10) {
                value += text.slice(s, i);
                value += '\n';
                line += 1;
                s = i + 1;
              }
            }
            value += text.slice(s, q);
          } else {
            value += text.slice(p, q);
          }
          if (text.charCodeAt(q + 1) === 34) {
            value += '"';
            p = q + 2;
            continue;
          }
          pos = q + 1;
          closed = true;
        }
        if (unterminated) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          const reread = readUnquotedSlow('"');
          fields.push(reread.value);
          ended = reread.ended;
          continue;
        }
        // After the closing quote: terminator, or junk to append.
        if (pos >= n) {
          ended = 3;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            ended = 1;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            ended = 2;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = 2;
          } else {
            const junk = readUnquotedSlow(value);
            if (junk.added > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
            value = junk.value;
            ended = junk.ended;
          }
        }
        fields.push(value);
        continue;
      }
      // Unquoted field: the next comma or newline ends it, so locate
      // the nearer of the two and slice the field whole. A CR before
      // that end is either the CR of a CRLF line break or a stray CR to
      // drop; the scan for it is bounded by the field's end.
      while (true) {
        const comma = text.indexOf(',', pos);
        const nl = text.indexOf('\n', pos);
        let end;
        let kind;
        if (comma === -1) {
          end = nl === -1 ? n : nl;
          kind = 2;
        } else if (nl === -1) {
          end = comma;
          kind = 1;
        } else if (comma < nl) {
          end = comma;
          kind = 1;
        } else {
          end = nl;
          kind = 2;
        }
        let cr = -1;
        for (let i = pos; i < end; i++) {
          if (text.charCodeAt(i) === 13) {
            cr = i;
            break;
          }
        }
        if (cr === -1) {
          value += text.slice(pos, end);
          if (kind === 1) {
            pos = end + 1;
            ended = 1;
          } else if (end >= n) {
            pos = n;
            ended = 3;
          } else {
            pos = end + 1;
            line += 1;
            ended = 2;
          }
          break;
        }
        value += text.slice(pos, cr);
        if (text.charCodeAt(cr + 1) === 10) {
          pos = cr + 2;
          line += 1;
          ended = 2;
          break;
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        pos = cr + 1;
        // The field goes on after the dropped CR.
      }
      fields.push(value);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
