"""增量写入的稳定入口。

服务按业务域拆分到 mutations/；server.py 和外部工具继续使用本模块。
不要在此增加 SQL、事务或业务规则，避免重新形成大文件。
"""

from .mutations.common import MutationServiceContext
from .mutations.common import to_int
from .mutations.effects import reconcile_task_sample_occupancy
from .mutations.effects import TASK_SAMPLE_MUTABLE_FIELDS
from .mutations.tasks import commit_task_mutation
from .mutations.tasks import commit_task_batch_mutation
from .mutations.samples import commit_sample_mutation
from .mutations.projects import commit_project_mutation
from .mutations.projects import commit_stage_mutation
from .mutations.samples import delete_sample_category_record
from .mutations.samples import commit_sample_category_mutation

__all__ = [
    "MutationServiceContext", "TASK_SAMPLE_MUTABLE_FIELDS", "to_int",
    "reconcile_task_sample_occupancy", "commit_task_mutation",
    "commit_task_batch_mutation", "commit_sample_mutation",
    "commit_project_mutation", "commit_stage_mutation",
    "delete_sample_category_record", "commit_sample_category_mutation",
]
