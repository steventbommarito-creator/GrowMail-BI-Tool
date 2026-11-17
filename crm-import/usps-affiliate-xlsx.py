"""Fill the USPS Monthly Affiliate Report template from usps-affiliate-report.js output.

    python3 crm-import/usps-affiliate-xlsx.py report.json template.xlsx out.xlsx

Keeps the template's layout and formatting for the summary sheet and adds an
"Orders" sheet listing every order counted, with why it was attributed to USPS.
"""
import json
import sys

import openpyxl
from openpyxl.styles import Font

report_path, template_path, out_path = sys.argv[1:4]
rep = json.load(open(report_path))
s = rep["summary"]

wb = openpyxl.load_workbook(template_path)
ws = wb["Monthly Affiliate Report"]
assert ws["A8"].value == "Postage Revenue" and ws["A18"].value.startswith("Total Volume"), "template layout changed"
ws["B5"] = s["monthLabel"]
for cell, key in [("B8", "postage"), ("B9", "production"), ("B10", "share"), ("B11", "totalUsps"),
                  ("B12", "totalCustomer"), ("B13", "newCustomers"), ("B14", "newRevenue"),
                  ("B15", "existingCustomers"), ("B16", "existingRevenue"), ("B17", "transactions"),
                  ("B18", "pieces")]:
    ws[cell] = s[key]

if "Orders" in wb.sheetnames:
    del wb["Orders"]
od = wb.create_sheet("Orders")
cols = [("Account", "account", 32), ("Order #", "order", 10), ("Close Date", "closed", 12),
        ("Account First Order", "firstOrder", 18), ("New / Existing", "type", 14),
        ("Production", "production", 13), ("Postage", "postage", 12), ("Pieces", "pieces", 10),
        ("Revenue From", "source", 26), ("USPS Attribution", "why", 60), ("Deal", "deal", 50)]
for i, (label, _, width) in enumerate(cols, 1):
    c = od.cell(row=1, column=i, value=label)
    c.font = Font(bold=True)
    od.column_dimensions[openpyxl.utils.get_column_letter(i)].width = width
for r, row in enumerate(rep["rows"], 2):
    for i, (_, key, _) in enumerate(cols, 1):
        c = od.cell(row=r, column=i, value=row[key])
        if key in ("production", "postage"):
            c.number_format = "$#,##0.00"
if not rep["rows"]:
    od.cell(row=2, column=1, value=f"No USPS-attributed Won orders closed {rep['from']} to {rep['to']} "
                                   f"({rep['wonDealsInMonth']} Won deals and {rep['contactsChecked']} contacts checked).")
wb.save(out_path)
print("saved", out_path)
