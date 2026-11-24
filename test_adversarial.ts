// Adversarial test suite for mend (SPEC.md version 1)
// Covers 40+ subtle edge cases across unified, search-replace, v4a, json, and cli.

import { runCheck } from './runner.ts';

interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

interface TestCase {
  name: string;
  check: Check;
  expect: {
    exit: number;
    stdout: string;
    files?: Record<string, string>;
  };
}

const tests: TestCase[] = [
  // -------------------------------------------------------------
  // 1. CLI INVOCATION & USAGE
  // -------------------------------------------------------------
  {
    name: 'CLI: unknown option before --',
    check: { id: 't01', argv: ['--foo'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: duplicate --check option',
    check: { id: 't02', argv: ['--check', '--check'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: duplicate --strict option',
    check: { id: 't03', argv: ['--strict', '--strict'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: duplicate --format option',
    check: { id: 't04', argv: ['--format=v4a', '--format=v4a'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: invalid format name',
    check: { id: 't05', argv: ['--format=diff'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: two positional arguments',
    check: { id: 't06', argv: ['p1.diff', 'p2.diff'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: -- turns option into positional argument',
    check: { id: 't07', argv: ['p1.diff', '--', '--check'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: usage\n' },
  },
  {
    name: 'CLI: missing patch file',
    check: { id: 't08', argv: ['nonexistent.patch'], stdin: null, files: {} },
    expect: { exit: 2, stdout: 'error: no-patch\n' },
  },
  {
    name: 'CLI: unreadable patch file (directory)',
    check: { id: 't09', argv: ['mydir'], stdin: null, files: { 'mydir/sub': 'x' } },
    expect: { exit: 2, stdout: 'error: no-patch\n' },
  },
  {
    name: 'CLI: no-op patch produces ok: 0 files',
    check: {
      id: 't10',
      argv: ['patch.diff'],
      stdin: null,
      files: {
        'foo.txt': 'hello\nworld\n',
        'patch.diff': 'foo.txt\n<<<<<<< SEARCH\nhello\n=======\nhello\n>>>>>>> REPLACE\n',
      },
    },
    expect: { exit: 0, stdout: 'ok: 0 files\n', files: { 'foo.txt': 'hello\nworld\n', 'patch.diff': 'foo.txt\n<<<<<<< SEARCH\nhello\n=======\nhello\n>>>>>>> REPLACE\n' } },
  },

  // -------------------------------------------------------------
  // 2. PATH SAFETY
  // -------------------------------------------------------------
  {
    name: 'Path safety: leading slash',
    check: {
      id: 't11',
      argv: ['patch.json'],
      stdin: null,
      files: { 'patch.json': '[{"command":"create","path":"/root/a.txt","file_text":"hi"}]' },
    },
    expect: { exit: 1, stdout: 'error: unsafe /root/a.txt\nfailed: 1 of 1 edits\n' },
  },
  {
    name: 'Path safety: backslash',
    check: {
      id: 't12',
      argv: ['patch.json'],
      stdin: null,
      files: { 'patch.json': '[{"command":"create","path":"dir\\\\a.txt","file_text":"hi"}]' },
    },
    expect: { exit: 1, stdout: 'error: unsafe dir\\a.txt\nfailed: 1 of 1 edits\n' },
  },
  {
    name: 'Path safety: parent segment ..',
    check: {
      id: 't13',
      argv: ['patch.json'],
      stdin: null,
      files: { 'patch.json': '[{"command":"create","path":"foo/../bar.txt","file_text":"hi"}]' },
    },
    expect: { exit: 1, stdout: 'error: unsafe foo/../bar.txt\nfailed: 1 of 1 edits\n' },
  },
  {
    name: 'Path safety: current segment .',
    check: {
      id: 't14',
      argv: ['patch.json'],
      stdin: null,
      files: { 'patch.json': '[{"command":"create","path":"./bar.txt","file_text":"hi"}]' },
    },
    expect: { exit: 1, stdout: 'error: unsafe ./bar.txt\nfailed: 1 of 1 edits\n' },
  },
  {
    name: 'Path safety: empty segment (double slash)',
    check: {
      id: 't15',
      argv: ['patch.json'],
      stdin: null,
      files: { 'patch.json': '[{"command":"create","path":"foo//bar.txt","file_text":"hi"}]' },
    },
    expect: { exit: 1, stdout: 'error: unsafe foo//bar.txt\nfailed: 1 of 1 edits\n' },
  },

  // -------------------------------------------------------------
  // 3. UNIFIED DIFFS (Shifted lines, tie-breaking, noeol, /dev/null)
  // -------------------------------------------------------------
  {
    name: 'Unified: shifted line number nearest match',
    check: {
      id: 't16',
      argv: ['change.diff'],
      stdin: null,
      files: {
        'file.txt': 'line 1\nline 2\nline 3\ntarget line\nline 5\n',
        'change.diff': '--- a/file.txt\n+++ b/file.txt\n@@ -10,3 +10,3 @@\n line 3\n-target line\n+updated line\n line 5\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M file.txt\nok: 1 file\n',
      files: { 'file.txt': 'line 1\nline 2\nline 3\nupdated line\nline 5\n' },
    },
  },
  {
    name: 'Unified: equidistant occurrences pick earlier',
    check: {
      id: 't17',
      argv: ['change.diff'],
      stdin: null,
      files: {
        'file.txt': 'line X\nline A\nline B\nline X\nline C\nline D\nline X\n',
        // Target A=4 -> index 3. Occurrences of 'line X' at 0, 3, 6. Distance to 0 is 3, distance to 6 is 3.
        'change.diff': '--- a/file.txt\n+++ b/file.txt\n@@ -4,1 +4,1 @@\n-line X\n+line Y\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M file.txt\nok: 1 file\n',
      files: { 'file.txt': 'line X\nline A\nline B\nline Y\nline C\nline D\nline X\n' },
    },
  },
  {
    name: 'Unified: equidistant occurrences tie (distance 1 vs 1) picks earlier',
    check: {
      id: 't18',
      argv: ['change.diff'],
      stdin: null,
      files: {
        'file.txt': 'line 0\npattern\nline 2\npattern\nline 4\n',
        // Target A=3 (line 3, index 2). Occurrences of pattern at index 1 and index 3.
        // Distance from 2 to 1 is 1. Distance from 2 to 3 is 1. Tie! Earlier (index 1) MUST win!
        'change.diff': '--- a/file.txt\n+++ b/file.txt\n@@ -3,1 +3,1 @@\n-pattern\n+REPLACED\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M file.txt\nok: 1 file\n',
      files: { 'file.txt': 'line 0\nREPLACED\nline 2\npattern\nline 4\n' },
    },
  },
  {
    name: 'Unified: empty O insert at start (A=0)',
    check: {
      id: 't19',
      argv: ['change.diff'],
      stdin: null,
      files: {
        'file.txt': 'line 1\nline 2\n',
        'change.diff': '--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1,1 @@\n+first line\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M file.txt\nok: 1 file\n',
      files: { 'file.txt': 'first line\nline 1\nline 2\n' },
    },
  },
  {
    name: 'Unified: empty O insert at end past file length',
    check: {
      id: 't20',
      argv: ['change.diff'],
      stdin: null,
      files: {
        'file.txt': 'line 1\nline 2\n',
        'change.diff': '--- a/file.txt\n+++ b/file.txt\n@@ -99,0 +99,1 @@\n+last line\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M file.txt\nok: 1 file\n',
      files: { 'file.txt': 'line 1\nline 2\nlast line\n' },
    },
  },
  {
    name: 'Unified: \\ No newline at end of file creates file without trailing newline',
    check: {
      id: 't21',
      argv: ['create.diff'],
      stdin: null,
      files: {
        'create.diff': '--- /dev/null\n+++ b/newfile.txt\n@@ -0,0 +1,2 @@\n+line one\n+line two\n\\ No newline at end of file\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'A newfile.txt\nok: 1 file\n',
      files: { 'newfile.txt': 'line one\nline two' },
    },
  },
  {
    name: 'Unified: deletion with deleted file mode and /dev/null',
    check: {
      id: 't22',
      argv: ['del.diff'],
      stdin: null,
      files: {
        'old.txt': 'goodbye\n',
        'del.diff': 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'D old.txt\nok: 1 file\n',
      files: {},
    },
  },
  {
    name: 'Unified: parse error on --- not followed by +++',
    check: {
      id: 't23',
      argv: ['bad.diff'],
      stdin: null,
      files: {
        'bad.diff': 'diff --git a/a.txt b/a.txt\n--- a/a.txt\nsomething else\n',
      },
    },
    expect: { exit: 2, stdout: 'error: parse 3\n' },
  },
  {
    name: 'Unified: parse error on hunk before any section with explicit --format=unified',
    check: {
      id: 't24',
      argv: ['--format=unified', 'bad.diff'],
      stdin: null,
      files: {
        'bad.diff': '@@ -1,2 +1,2 @@\n context\n',
      },
    },
    expect: { exit: 2, stdout: 'error: parse 1\n' },
  },

  // -------------------------------------------------------------
  // 4. SEARCH / REPLACE BLOCKS
  // -------------------------------------------------------------
  {
    name: 'SEARCH/REPLACE: multi-block for same file with second block inheriting path',
    check: {
      id: 't25',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'code.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
        'sr.patch': 'code.js\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 10;\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nconst c = 3;\n=======\nconst c = 30;\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M code.js\nok: 1 file\n',
      files: { 'code.js': 'const a = 10;\nconst b = 2;\nconst c = 30;\n' },
    },
  },
  {
    name: 'SEARCH/REPLACE: code fences around block are ignored',
    check: {
      id: 't26',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'target.py': 'def foo():\n    return 42\n',
        'sr.patch': '```python\ntarget.py\n<<<<<<< SEARCH\n    return 42\n=======\n    return 100\n>>>>>>> REPLACE\n```\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M target.py\nok: 1 file\n',
      files: { 'target.py': 'def foo():\n    return 100\n' },
    },
  },
  {
    name: 'SEARCH/REPLACE: empty old lines creates file',
    check: {
      id: 't27',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'sr.patch': 'brand_new.txt\n<<<<<<< SEARCH\n=======\nhello world\nnew file\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'A brand_new.txt\nok: 1 file\n',
      files: { 'brand_new.txt': 'hello world\nnew file\n' },
    },
  },
  {
    name: 'SEARCH/REPLACE: empty new lines deletes matched lines',
    check: {
      id: 't28',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'trim.txt': 'keep 1\ndelete me\nkeep 2\n',
        'sr.patch': 'trim.txt\n<<<<<<< SEARCH\ndelete me\n=======\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M trim.txt\nok: 1 file\n',
      files: { 'trim.txt': 'keep 1\nkeep 2\n' },
    },
  },
  {
    name: 'SEARCH/REPLACE: ambiguous match causes exit 1',
    check: {
      id: 't29',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'dups.txt': 'duplicate\nline\nduplicate\n',
        'sr.patch': 'dups.txt\n<<<<<<< SEARCH\nduplicate\n=======\nreplaced\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 1,
      stdout: 'error: ambiguous dups.txt\nfailed: 1 of 1 edits\n',
    },
  },
  {
    name: 'SEARCH/REPLACE: tier 2 re-indentation with tab indentation',
    check: {
      id: 't30',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'indented.py': 'def test():\n\tif True:\n\t\tval = 1\n\t\treturn val\n',
        'sr.patch': 'indented.py\n<<<<<<< SEARCH\nval = 1\nreturn val\n=======\nval = 2\nval += 3\nreturn val\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M indented.py\nok: 1 file\n',
      files: { 'indented.py': 'def test():\n\tif True:\n\t\tval = 2\n\t\tval += 3\n\t\treturn val\n' },
    },
  },
  {
    name: 'SEARCH/REPLACE: missing ======= line causes parse error on SEARCH line',
    check: {
      id: 't31',
      argv: ['sr.patch'],
      stdin: null,
      files: {
        'sr.patch': 'file.txt\n<<<<<<< SEARCH\nsome lines\n>>>>>>> REPLACE\n',
      },
    },
    expect: { exit: 2, stdout: 'error: parse 2\n' },
  },

  // -------------------------------------------------------------
  // 5. V4A PATCHES (Cursor, anchors, EOF chunk, Move to)
  // -------------------------------------------------------------
  {
    name: 'V4A: parse error on missing End Patch line counts lines+1',
    check: {
      id: 't32',
      argv: ['v4a.patch'],
      stdin: null,
      files: {
        'v4a.patch': '*** Begin Patch\n*** Add File: hello.txt\n+hello\n',
      },
    },
    expect: { exit: 2, stdout: 'error: parse 4\n' },
  },
  {
    name: 'V4A: cursor progression across multiple chunks',
    check: {
      id: 't33',
      argv: ['v4a.patch'],
      stdin: null,
      files: {
        'doc.txt': 'section 1\nitem\nsection 2\nitem\nsection 3\n',
        'v4a.patch': '*** Begin Patch\n*** Update File: doc.txt\n@@ section 1\n-item\n+item 1\n@@ section 2\n-item\n+item 2\n*** End Patch\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M doc.txt\nok: 1 file\n',
      files: { 'doc.txt': 'section 1\nitem 1\nsection 2\nitem 2\nsection 3\n' },
    },
  },
  {
    name: 'V4A: *** End of File chunk requires match at EOF',
    check: {
      id: 't34',
      argv: ['v4a.patch'],
      stdin: null,
      files: {
        'code.js': 'function end() {\n  return 1;\n}\n// other code\nfunction end() {\n  return 1;\n}\n',
        'v4a.patch': '*** Begin Patch\n*** Update File: code.js\n function end() {\n-  return 1;\n+  return 2;\n }\n*** End of File\n*** End Patch\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M code.js\nok: 1 file\n',
      files: { 'code.js': 'function end() {\n  return 1;\n}\n// other code\nfunction end() {\n  return 2;\n}\n' },
    },
  },
  {
    name: 'V4A: Move to renames and modifies file simultaneously',
    check: {
      id: 't35',
      argv: ['v4a.patch'],
      stdin: null,
      files: {
        'old_name.txt': 'start\nmiddle\nend\n',
        'v4a.patch': '*** Begin Patch\n*** Update File: old_name.txt\n*** Move to: new_dir/new_name.txt\n start\n-middle\n+center\n end\n*** End Patch\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'R old_name.txt -> new_dir/new_name.txt\nok: 1 file\n',
      files: { 'new_dir/new_name.txt': 'start\ncenter\nend\n' },
    },
  },

  // -------------------------------------------------------------
  // 6. JSON EDITS & CRLF
  // -------------------------------------------------------------
  {
    name: 'JSON: str_replace in CRLF file preserves CRLF',
    check: {
      id: 't36',
      argv: ['edit.json'],
      stdin: null,
      files: {
        'crlf.txt': 'first line\r\nsecond line\r\nthird line\r\n',
        'edit.json': '[{"command":"str_replace","path":"crlf.txt","old_str":"second line","new_str":"2nd line"}]',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M crlf.txt\nok: 1 file\n',
      files: { 'crlf.txt': 'first line\r\n2nd line\r\nthird line\r\n' },
    },
  },
  {
    name: 'JSON: insert line 0 inserts at beginning of file',
    check: {
      id: 't37',
      argv: ['edit.json'],
      stdin: null,
      files: {
        'top.txt': 'line 1\nline 2\n',
        'edit.json': '[{"command":"insert","path":"top.txt","insert_line":0,"new_str":"top line\\n"}]',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M top.txt\nok: 1 file\n',
      files: { 'top.txt': 'top line\nline 1\nline 2\n' },
    },
  },

  // -------------------------------------------------------------
  // 7. ATOMIC ROLLBACK ON PARTIAL FAILURE
  // -------------------------------------------------------------
  {
    name: 'Atomicity: failure in edit 2 rolls back edit 1',
    check: {
      id: 't38',
      argv: ['atomic.patch'],
      stdin: null,
      files: {
        'f1.txt': 'original 1\n',
        'atomic.patch': 'f1.txt\n<<<<<<< SEARCH\noriginal 1\n=======\nchanged 1\n>>>>>>> REPLACE\n\nf2_missing.txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 1,
      stdout: 'error: missing f2_missing.txt\nfailed: 1 of 2 edits\n',
      files: { 'f1.txt': 'original 1\n' },
    },
  },
  {
    name: 'Check mode: --check reports changes but leaves disk untouched',
    check: {
      id: 't39',
      argv: ['--check', 'patch.diff'],
      stdin: null,
      files: {
        'target.txt': 'old content\n',
        'patch.diff': 'target.txt\n<<<<<<< SEARCH\nold content\n=======\nnew content\n>>>>>>> REPLACE\n',
      },
    },
    expect: {
      exit: 0,
      stdout: 'M target.txt\nok: 1 file\n',
      files: { 'target.txt': 'old content\n', 'patch.diff': 'target.txt\n<<<<<<< SEARCH\nold content\n=======\nnew content\n>>>>>>> REPLACE\n' },
    },
  },
  {
    name: 'Sorting: UTF-8 byte order sorting of multiple outputs',
    check: {
      id: 't40',
      argv: ['multi.json'],
      stdin: null,
      files: {
        'multi.json': JSON.stringify([
          { command: 'create', path: 'zebra.txt', file_text: 'z\n' },
          { command: 'create', path: 'apple.txt', file_text: 'a\n' },
          { command: 'create', path: 'Banana.txt', file_text: 'B\n' },
        ]),
      },
    },
    expect: {
      exit: 0,
      stdout: 'A Banana.txt\nA apple.txt\nA zebra.txt\nok: 3 files\n',
    },
  },
];

let passed = 0;
for (const t of tests) {
  const got = runCheck(t.check);
  const why: string[] = [];
  if (got.exit !== t.expect.exit) {
    why.push(`exit ${got.exit}, expected ${t.expect.exit}`);
  }
  if (got.stdout !== t.expect.stdout) {
    why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(t.expect.stdout)}`);
  }
  if (t.expect.files) {
    for (const [p, expContent] of Object.entries(t.expect.files)) {
      if (got.files[p] === undefined) {
        why.push(`file ${p} is missing`);
      } else if (got.files[p] !== expContent) {
        why.push(`file ${p} differs: expected ${JSON.stringify(expContent)}, got ${JSON.stringify(got.files[p])}`);
      }
    }
  }

  if (why.length === 0) {
    passed += 1;
    process.stdout.write(`PASS ${t.name}\n`);
  } else {
    process.stdout.write(`FAIL ${t.name}\n  ${why.join('\n  ')}\n`);
  }
}

process.stdout.write(`\nTotal: ${passed} of ${tests.length} adversarial tests passed.\n`);
if (passed !== tests.length) process.exit(1);
