-- SF-002: one immutable canonical repository receipt per newly provisioned
-- run. Legacy NULL/missing-identity JSON remains readable, but no later update
-- may promote or replace it into mutation authority.

ALTER TABLE `projects` ADD `repository_identity` text;
--> statement-breakpoint

CREATE TRIGGER `projects_repository_identity_insert_guard`
BEFORE INSERT ON `projects`
WHEN NEW.`repository_identity` IS NOT NULL
AND COALESCE((
  json_valid(NEW.`repository_identity`) = 1
  AND json_type(NEW.`repository_identity`) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`repository_identity`) AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  AND (SELECT count(*) FROM json_each(NEW.`repository_identity`)) = 3
  AND json_extract(NEW.`repository_identity`, '$.protocol') = 'git-common-dir-v1'
  AND json_type(NEW.`repository_identity`, '$.gitCommonDir') = 'text'
  AND trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir')) <> ''
  AND json_extract(NEW.`repository_identity`, '$.gitCommonDir') = trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir'))
  AND json_type(NEW.`repository_identity`, '$.leaseKey') = 'text'
  AND length(json_extract(NEW.`repository_identity`, '$.leaseKey')) = 71
  AND substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 8) NOT GLOB '*[^0-9a-f]*'
), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'project repository identity requires an exact receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `projects_repository_identity_update_guard`
BEFORE UPDATE OF `repository_identity` ON `projects`
WHEN NEW.`repository_identity` IS NOT NULL
AND COALESCE((
  json_valid(NEW.`repository_identity`) = 1
  AND json_type(NEW.`repository_identity`) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`repository_identity`) AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  AND (SELECT count(*) FROM json_each(NEW.`repository_identity`)) = 3
  AND json_extract(NEW.`repository_identity`, '$.protocol') = 'git-common-dir-v1'
  AND json_type(NEW.`repository_identity`, '$.gitCommonDir') = 'text'
  AND trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir')) <> ''
  AND json_extract(NEW.`repository_identity`, '$.gitCommonDir') = trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir'))
  AND json_type(NEW.`repository_identity`, '$.leaseKey') = 'text'
  AND length(json_extract(NEW.`repository_identity`, '$.leaseKey')) = 71
  AND substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 8) NOT GLOB '*[^0-9a-f]*'
), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'project repository identity requires an exact receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `projects_repository_identity_immutable_guard`
BEFORE UPDATE OF `repository_identity` ON `projects`
WHEN OLD.`repository_identity` IS NOT NULL
AND NEW.`repository_identity` IS NOT OLD.`repository_identity`
BEGIN
  SELECT RAISE(ABORT, 'project repository identity is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_repository_receipt_insert_guard`
BEFORE INSERT ON `agent_runs`
WHEN NEW.`snapshot_state` = 'stamped'
AND NEW.`git_receipt` IS NOT NULL
AND COALESCE((
  json_valid(NEW.`git_receipt`) = 1
  AND json_type(NEW.`git_receipt`) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`git_receipt`) AS field
    WHERE field.key NOT IN (
      'worktreePath', 'branch', 'baseBranch', 'baseSha', 'cleanStatus',
      'repositoryIdentity'
    )
  )
  AND (SELECT count(*) FROM json_each(NEW.`git_receipt`)) = 6
  AND json_type(NEW.`git_receipt`, '$.worktreePath') = 'text'
  AND trim(json_extract(NEW.`git_receipt`, '$.worktreePath')) <> ''
  AND json_extract(NEW.`git_receipt`, '$.worktreePath') = trim(json_extract(NEW.`git_receipt`, '$.worktreePath'))
  AND json_type(NEW.`git_receipt`, '$.branch') = 'text'
  AND trim(json_extract(NEW.`git_receipt`, '$.branch')) <> ''
  AND json_extract(NEW.`git_receipt`, '$.branch') = trim(json_extract(NEW.`git_receipt`, '$.branch'))
  AND json_type(NEW.`git_receipt`, '$.baseBranch') = 'text'
  AND trim(json_extract(NEW.`git_receipt`, '$.baseBranch')) <> ''
  AND json_extract(NEW.`git_receipt`, '$.baseBranch') = trim(json_extract(NEW.`git_receipt`, '$.baseBranch'))
  AND json_type(NEW.`git_receipt`, '$.baseSha') = 'text'
  AND trim(json_extract(NEW.`git_receipt`, '$.baseSha')) <> ''
  AND json_extract(NEW.`git_receipt`, '$.baseSha') = trim(json_extract(NEW.`git_receipt`, '$.baseSha'))
  AND json_type(NEW.`git_receipt`, '$.cleanStatus') IN ('true', 'false')
  AND json_type(NEW.`git_receipt`, '$.repositoryIdentity') = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`git_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  AND (SELECT count(*) FROM json_each(NEW.`git_receipt`, '$.repositoryIdentity')) = 3
  AND json_extract(NEW.`git_receipt`, '$.repositoryIdentity.protocol') = 'git-common-dir-v1'
  AND json_type(NEW.`git_receipt`, '$.repositoryIdentity.gitCommonDir') = 'text'
  AND trim(json_extract(NEW.`git_receipt`, '$.repositoryIdentity.gitCommonDir')) <> ''
  AND json_extract(NEW.`git_receipt`, '$.repositoryIdentity.gitCommonDir') = trim(json_extract(NEW.`git_receipt`, '$.repositoryIdentity.gitCommonDir'))
  AND json_type(NEW.`git_receipt`, '$.repositoryIdentity.leaseKey') = 'text'
  AND length(json_extract(NEW.`git_receipt`, '$.repositoryIdentity.leaseKey')) = 71
  AND substr(json_extract(NEW.`git_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) = 'sha256:'
  AND substr(json_extract(NEW.`git_receipt`, '$.repositoryIdentity.leaseKey'), 8) NOT GLOB '*[^0-9a-f]*'
), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'agent run git receipt requires a complete repository identity');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_repository_receipt_immutable_guard`
BEFORE UPDATE OF `git_receipt` ON `agent_runs`
WHEN NEW.`git_receipt` IS NOT OLD.`git_receipt`
BEGIN
  SELECT RAISE(ABORT, 'agent run repository identity receipt is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_repository_receipt_continuation_guard`
BEFORE INSERT ON `agent_runs`
WHEN NEW.`snapshot_state` = 'stamped'
AND NEW.`continues` IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM `agent_runs` AS parent
  WHERE parent.`id` = NEW.`continues`
    AND parent.`git_receipt` IS NEW.`git_receipt`
)
BEGIN
  SELECT RAISE(ABORT, 'agent run continuation must inherit exact repository identity receipt');
END;
