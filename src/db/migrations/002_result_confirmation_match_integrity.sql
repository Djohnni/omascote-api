ALTER TABLE match_result_confirmations
  DROP CONSTRAINT match_result_confirmations_submission_id_submission_versio_fkey;

ALTER TABLE match_result_submissions
  DROP CONSTRAINT match_result_submissions_id_version_submission_hash_key;

ALTER TABLE match_result_submissions
  ADD CONSTRAINT match_result_submissions_identity_match_version_hash_key
  UNIQUE (id, match_id, version, submission_hash);

ALTER TABLE match_result_confirmations
  ADD CONSTRAINT match_result_confirmations_submission_same_match_fkey
  FOREIGN KEY (submission_id, match_id, submission_version, submission_hash)
  REFERENCES match_result_submissions(id, match_id, version, submission_hash);
