"""
The product's name, in one place.

The name appears in page titles, email subjects and both legal documents. One constant means a
rename is one edit here rather than a search across prose, where a missed instance reads as
carelessness in exactly the documents where carelessness is expensive.

It only helps where it is actually referenced, so everything that says the name says it from here:
page titles, the reset email's subject, both legal documents. The one place that had been missed
offered to reset a password for a product by name, and would have kept doing so after a rename.

Overridable by environment so the server can be renamed without a redeploy of the image.
"""

import os

PRODUCT_NAME = os.environ.get("PRODUCT_NAME", "AudioNotes")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "InnoCore Labs")
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "admin@innocorelabs.com")

#: Bumped when either legal document changes materially. Shown on both pages.
LEGAL_UPDATED = "29 August 2026"
