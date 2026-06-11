-- ============================================================
-- 版本管理
-- ============================================================

-- 活跃版本指针（每个 repo+branch 一条记录）
CREATE TABLE IF NOT EXISTS active_versions (
    repo        VARCHAR(128) NOT NULL,
    branch      VARCHAR(128) NOT NULL,
    version_id  VARCHAR(64)  NOT NULL,
    updated_at  BIGINT       NOT NULL,
    PRIMARY KEY (repo, branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 版本历史记录（保留最近 7 个版本供历史查询）
CREATE TABLE IF NOT EXISTS version_history (
    id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo        VARCHAR(128)  NOT NULL,
    branch      VARCHAR(128)  NOT NULL,
    version_id  VARCHAR(64)   NOT NULL,
    status      ENUM('active', 'retained', 'deleting') NOT NULL DEFAULT 'active',
    node_count  INT           DEFAULT 0,
    edge_count  INT           DEFAULT 0,
    file_count  INT           DEFAULT 0,
    created_at  BIGINT        NOT NULL,
    deleted_at  BIGINT,
    UNIQUE KEY uk_version (repo, branch, version_id),
    INDEX idx_repo_branch_status (repo, branch, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 核心表（每行带 repo + branch + version_id）
-- ============================================================

CREATE TABLE IF NOT EXISTS nodes (
    id              VARCHAR(128)  NOT NULL,
    repo            VARCHAR(128)  NOT NULL,
    branch          VARCHAR(128)  NOT NULL,
    version_id      VARCHAR(64)   NOT NULL,

    kind            VARCHAR(32)   NOT NULL,
    name            VARCHAR(512)  NOT NULL,
    qualified_name  VARCHAR(1024) NOT NULL,
    file_path       VARCHAR(1024) NOT NULL,
    language        VARCHAR(32)   NOT NULL,
    start_line      INT           NOT NULL,
    end_line        INT           NOT NULL,
    start_column    INT           NOT NULL,
    end_column      INT           NOT NULL,
    docstring       TEXT,
    signature       TEXT,
    source_code     MEDIUMTEXT,          -- ★ 核心新增：完整源码片段
    visibility      VARCHAR(16),
    is_exported     TINYINT       DEFAULT 0,
    is_async        TINYINT       DEFAULT 0,
    is_static       TINYINT       DEFAULT 0,
    is_abstract     TINYINT       DEFAULT 0,
    decorators      JSON,
    type_parameters JSON,
    updated_at      BIGINT        NOT NULL,

    PRIMARY KEY (repo, branch, version_id, id),

    INDEX idx_nodes_kind        (repo, branch, version_id, kind),
    INDEX idx_nodes_name        (repo, branch, version_id, name(128)),
    INDEX idx_nodes_qname       (repo, branch, version_id, qualified_name(256)),
    INDEX idx_nodes_file        (repo, branch, version_id, file_path(256)),
    INDEX idx_nodes_file_line   (repo, branch, version_id, file_path(256), start_line),
    FULLTEXT INDEX ft_nodes     (name, qualified_name, docstring, signature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS edges (
    id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo        VARCHAR(128)  NOT NULL,
    branch      VARCHAR(128)  NOT NULL,
    version_id  VARCHAR(64)   NOT NULL,

    source      VARCHAR(128)  NOT NULL,
    target      VARCHAR(128)  NOT NULL,
    kind        VARCHAR(32)   NOT NULL,
    metadata    JSON,
    line        INT,
    col         INT,
    provenance  VARCHAR(32),

    INDEX idx_edges_source_kind (repo, branch, version_id, source, kind),
    INDEX idx_edges_target_kind (repo, branch, version_id, target, kind),
    INDEX idx_edges_kind        (repo, branch, version_id, kind),
    INDEX idx_edges_provenance  (repo, branch, version_id, provenance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS files (
    path          VARCHAR(1024) NOT NULL,
    repo          VARCHAR(128)  NOT NULL,
    branch        VARCHAR(128)  NOT NULL,
    version_id    VARCHAR(64)   NOT NULL,

    content_hash  VARCHAR(64)   NOT NULL,
    language      VARCHAR(32)   NOT NULL,
    size          INT           NOT NULL,
    modified_at   BIGINT        NOT NULL,
    indexed_at    BIGINT        NOT NULL,
    node_count    INT           DEFAULT 0,
    errors        JSON,

    PRIMARY KEY (repo, branch, version_id, path(256)),
    INDEX idx_files_lang     (repo, branch, version_id, language),
    INDEX idx_files_modified (repo, branch, version_id, modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 未解析引用（仅写入阶段临时使用，不需要跨版本查询）
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo            VARCHAR(128)  NOT NULL,
    branch          VARCHAR(128)  NOT NULL,
    version_id      VARCHAR(64)   NOT NULL,

    from_node_id    VARCHAR(128)  NOT NULL,
    reference_name  VARCHAR(512)  NOT NULL,
    reference_kind  VARCHAR(32)   NOT NULL,
    line            INT           NOT NULL,
    col             INT           NOT NULL,
    candidates      JSON,
    file_path       VARCHAR(1024) NOT NULL DEFAULT '',
    language        VARCHAR(32)   NOT NULL DEFAULT 'unknown',

    INDEX idx_unresolved_from (repo, branch, version_id, from_node_id),
    INDEX idx_unresolved_name (repo, branch, version_id, reference_name(128)),
    INDEX idx_unresolved_file (repo, branch, version_id, file_path(256))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 项目元数据
CREATE TABLE IF NOT EXISTS project_metadata (
    repo        VARCHAR(128) NOT NULL,
    branch      VARCHAR(128) NOT NULL,
    version_id  VARCHAR(64)  NOT NULL,
    `key`       VARCHAR(255) NOT NULL,
    value       TEXT         NOT NULL,
    updated_at  BIGINT       NOT NULL,
    PRIMARY KEY (repo, branch, version_id, `key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Schema 版本追踪
CREATE TABLE IF NOT EXISTS schema_versions (
    version     INT PRIMARY KEY,
    applied_at  BIGINT NOT NULL,
    description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
