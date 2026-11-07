---
name: office-documents
description: Build and check Excel workbooks, Word documents and PowerPoint decks (.xlsx, .docx, .pptx) with live formulas, styled tables, native charts and clean layouts, from data or notes. Use for spreadsheets, reports, memos, forms, slide decks, and turning CSV or Excel data into a finished document.
---

# Excel, Word and PowerPoint files

Work at the file level with Python: `openpyxl` for workbooks, `python-docx` for documents, `python-pptx` for decks,
`pandas` for data. Use the project's environment, or create one with pixi in a new project.

1. **Read the inputs.** Print the data's shape, columns, types and a few rows; inspect existing Office files' sheets,
   styles and placeholders before changing them.
2. **One script per deliverable** (`build_report.py`) that builds the file from the sources, so it reruns after a fix.
   Save to the exact path asked for. Never overwrite a source file; write a new one unless told to edit in place.
3. **Workbooks:** real formulas (not pasted values) where the person will change inputs, Excel tables for data, number
   formats with units, frozen header rows, column widths that fit, and native charts.
4. **Documents and decks:** headings as real heading styles, tables with a header row, figures at print resolution
   with captions, consistent fonts; one idea per slide.
5. **Check:** reopen the file and list sheets, tables, charts and formulas; recompute a few values in pandas and
   compare; convert to PDF (LibreOffice `soffice --headless --convert-to pdf` when available) and look at every page
   or slide for clipped text, `#####` cells, overlapping charts and wrong numbers.
6. **Report** the paths, what each sheet, section or slide holds, and the checks run.
