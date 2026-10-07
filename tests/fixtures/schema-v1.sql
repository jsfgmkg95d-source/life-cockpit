CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        setup_completed INTEGER NOT NULL DEFAULT 0 CHECK(setup_completed IN (0,1)),
        updated_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
        project_type TEXT NOT NULL CHECK(project_type IN ('novel','publication','product','research','foundation')),
        platform TEXT,
        operating_role TEXT NOT NULL CHECK(operating_role IN ('cashflow','growth','future_asset','maintenance')),
        stage TEXT NOT NULL DEFAULT '待确认' CHECK(length(trim(stage)) BETWEEN 1 AND 120),
        status TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','active','paused','completed','archived')),
        primary_metric_key TEXT,
        baseline_value INTEGER CHECK(baseline_value IS NULL OR baseline_value >= 0),
        baseline_at TEXT,
        baseline_source TEXT,
        target_value INTEGER CHECK(target_value IS NULL OR target_value > 0),
        target_date TEXT,
        next_milestone TEXT,
        next_action TEXT,
        daily_budget_minutes INTEGER CHECK(daily_budget_minutes IS NULL OR daily_budget_minutes BETWEEN 0 AND 1440),
        cadence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cadence_json)),
        notes TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((baseline_value IS NULL AND baseline_at IS NULL AND baseline_source IS NULL)
          OR (baseline_value IS NOT NULL AND baseline_at IS NOT NULL AND baseline_source IS NOT NULL AND length(trim(baseline_source)) > 0)),
        CHECK(primary_metric_key IS NOT NULL OR (baseline_value IS NULL AND target_value IS NULL))
      ) STRICT;
CREATE TABLE request_dedup (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope,request_id)
      ) STRICT;
CREATE INDEX projects_status_idx ON projects(status);
PRAGMA user_version = 1;
