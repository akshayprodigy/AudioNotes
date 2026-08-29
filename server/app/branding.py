"""
The product's name, in one place.

The app is being renamed before launch — "AudioNotes" is taken — and the name appears in page
titles, email subjects and both legal documents. One constant means the rename is one edit here
rather than a search across prose, where a missed instance reads as carelessness in exactly the
documents where carelessness is expensive.

Overridable by environment so the server can be renamed without a redeploy of the image.
"""

import os

PRODUCT_NAME = os.environ.get("PRODUCT_NAME", "AudioNotes")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "InnoCore Labs")
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "admin@innocorelabs.com")

#: Bumped when either legal document changes materially. Shown on both pages.
LEGAL_UPDATED = "29 August 2026"
