-- Past papers: the course's own sat papers, indexed alongside everything else.
--
-- No new tables and no new columns. That is the point: a past paper is an
-- ordinary document with an ordinary doc_type, so every existing path — the
-- hybrid search function, the topic filter, RLS, the admin inventory — reaches
-- it without being taught about it. What this migration adds is the index the
-- one new access pattern needs, and a written record of what the new type
-- means, because doc_type is a bare text column and the only documentation it
-- has ever had was a comment in 0001 that is now out of date.

comment on column documents.doc_type is
  'textbook | grammar | reading | kanji | answer_key | slides | past_paper. '
  'past_paper is a paper students actually sat, as opposed to material that '
  'teaches: it is what the quiz generator reads for question format and '
  'difficulty. Never citable — a citation points at a page of a book the '
  'student owns, and a sat paper has no such page.';

comment on column documents.topics is
  'Every topic the document covers. Read from the path for handouts. For a '
  'past-paper compilation it is read off the page headers instead, because '
  'one file holds a whole term of papers and its filename names no topic at '
  'all — see ingest/cli.py::_page_topics.';

-- Quiz generation asks, once per level per cache window: "which chunks belong
-- to a past paper at this level?" Without this it is a sequential scan over
-- documents on every miss. Partial, because past papers are a small minority
-- of the corpus and the index only ever serves this one question.
create index if not exists documents_past_papers_idx
  on documents (level)
  where doc_type = 'past_paper';

-- Chunk metadata gained exam_term, paper_title and is_past_paper. Nothing
-- queries them by value today — they are read off rows already fetched — so
-- they get no index; this note exists so the next person looking for one
-- knows it was a decision rather than an oversight.
