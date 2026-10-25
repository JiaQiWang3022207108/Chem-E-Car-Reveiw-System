# EDP archive fixtures

The archives in this directory contain only synthetic test documents. They do
not include any real team or participant information. They exist solely to
exercise archive signature detection, nested paths, entry enumeration, and
encrypted-archive rejection.

`sevenzip-source/` contains the four tiny PDF-header files used to regenerate
`nested-round2.7z`; keeping the sources makes the fixture roles and provenance
reviewable without opening the archive.
