---
name: pdf-forms
description: Fill PDF forms accurately: list the form's fields, map the person's information onto them, fill and save a copy, and check the result. Use for any fillable PDF (applications, travel or purchase forms, permits, questionnaires), and for reading what a filled form says.
---

# PDF forms

1. `pdf_fields` on the form: every field's name, type (text, checkbox, radio, choice), current value and options.
2. Map the person's information onto the fields. Field names are often cryptic: use each field's label, position and
   options to decide. Ask before guessing anything that matters (dates, amounts, identifiers, signatures).
3. `pdf_fill` with the values; it writes a filled copy and leaves the original untouched. Checkboxes and radios take
   one of the field's own option values.
4. Check: `pdf_fields` on the filled copy and compare every value with what you meant; open it with `show` so the
   person can see it. Report fields left empty on purpose.
5. Never enter passwords, card numbers or government identifiers yourself; leave those fields for the person.

A form with no fields (a scanned page) can't be filled this way: say so and offer to make a fillable version or a
filled overlay instead.
