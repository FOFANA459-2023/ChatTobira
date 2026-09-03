"""Promotion of approved student uploads into the corpus.

The path logic here is a deliberate mirror of web/lib/uploads.ts: the admin
is shown a destination path in the review queue BEFORE approving, and a
review is worth little if the file then lands somewhere else. These tests
pin the cases where the two implementations could drift apart.
"""

from __future__ import annotations

import json

from ingest.uploads import corpus_path, safe_filename


class TestSafeFilename:
    def test_keeps_japanese_names(self):
        # Most handouts in this course are named in Japanese.
        assert safe_filename("文法復習シート_T12(答え).pdf") == "文法復習シート_T12(答え).pdf"

    def test_strips_path_separators(self):
        assert safe_filename("../../etc/passwd") == "..-..-etc-passwd"
        assert safe_filename("a\\b:c*d?e.pdf") == "a-b-c-d-e.pdf"

    def test_collapses_whitespace(self):
        assert safe_filename("  a   b  .pdf ") == "a b .pdf"

    def test_truncates_a_very_long_name(self):
        assert len(safe_filename("x" * 400)) == 120

    def test_replaces_a_punctuation_only_name(self):
        # This side writes to the filesystem, so it must not trust the
        # browser to have sanitised anything: ".." as a path segment would
        # place the file one directory ABOVE where it was reviewed to go.
        for name in ("..", ".", "///", "   ", "-"):
            assert safe_filename(name) == "upload"

    def test_agrees_with_the_typescript_mirror(self):
        # The exact cases pinned in web/lib/__tests__/uploads.test.ts.
        assert safe_filename("../../etc/passwd") == "..-..-etc-passwd"
        assert safe_filename(r"a\b:c*d?e.pdf") == "a-b-c-d-e.pdf"
        assert safe_filename("..") == "upload"


class TestCorpusPath:
    def test_files_an_upload_where_discover_reads_level_and_topic_back(self):
        assert (
            corpus_path("F3", "T13", "worksheet.pdf")
            == "Foundation 3/T13 Student uploads/worksheet.pdf"
        )

    def test_matches_every_level_folder(self):
        assert corpus_path("F2", "T6", "a.pdf") == "Foundation 2/T6 Student uploads/a.pdf"
        assert corpus_path("INT", "T1", "a.pdf") == "Intermediate/T1 Student uploads/a.pdf"

    def test_untopiced_upload_still_lands_in_its_level(self):
        assert corpus_path("F3", None, "a.pdf") == "Foundation 3/Student uploads/a.pdf"

    def test_cannot_escape_the_uploads_folder(self):
        path = corpus_path("F3", "T13", "../../../.env")
        assert ".." not in path.split("/")
        assert path.startswith("Foundation 3/")

    def test_discover_can_read_the_path_back(self):
        """The whole point of encoding level and topic in the folder name."""
        from ingest.discover import _level_of, _topics_of

        path = corpus_path("F3", "T13", "worksheet.pdf")
        assert _level_of(path) == "F3"
        assert _topics_of(path) == ["T13"]


class TestTranscript:
    def test_written_in_the_shape_push_expects(self, tmp_path, monkeypatch):
        import ingest.config as config_module
        import ingest.uploads as uploads_module

        monkeypatch.setenv("WORK_DIR", str(tmp_path))
        monkeypatch.setattr(uploads_module, "CONFIG", config_module.Config())

        path = uploads_module.write_transcript("abc123def456ff", "# みだし\n食べる")
        pages = json.loads(path.read_text("utf-8"))

        assert len(pages) == 1
        page = pages[0]
        # Same keys PageText carries, or _load_pages cannot construct it.
        assert set(page) == {
            "pdf_page",
            "markdown",
            "book_page",
            "grammar_points",
            "has_japanese",
        }
        assert page["has_japanese"] is True
        # A photograph of a handout has no printed folio; inventing one would
        # produce a citation pointing at a page that does not exist.
        assert page["book_page"] is None

    def test_loads_back_as_pagetext(self, tmp_path, monkeypatch):
        import ingest.config as config_module
        import ingest.uploads as uploads_module
        from ingest.transcribe import PageText

        monkeypatch.setenv("WORK_DIR", str(tmp_path))
        monkeypatch.setattr(uploads_module, "CONFIG", config_module.Config())

        path = uploads_module.write_transcript("0011223344aa", "ひらがな")
        pages = [PageText(**p) for p in json.loads(path.read_text("utf-8"))]
        assert pages[0].markdown == "ひらがな"

    def test_english_only_upload_is_flagged_as_such(self, tmp_path, monkeypatch):
        import ingest.config as config_module
        import ingest.uploads as uploads_module

        monkeypatch.setenv("WORK_DIR", str(tmp_path))
        monkeypatch.setattr(uploads_module, "CONFIG", config_module.Config())

        path = uploads_module.write_transcript("aabbccddeeff", "just english here")
        assert json.loads(path.read_text("utf-8"))[0]["has_japanese"] is False
