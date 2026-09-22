"""Guard the extracted service boundary and catch lost module dependencies."""
import builtins
import dis
import importlib
import inspect
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import server
from server_modules import mutation_services


class MutationModuleTests(unittest.TestCase):
    def test_facade_keeps_service_identity(self):
        for module, names in {
            'tasks': ('commit_task_mutation', 'commit_task_batch_mutation'),
            'projects': ('commit_project_mutation', 'commit_stage_mutation'),
            'samples': ('commit_sample_mutation', 'commit_sample_category_mutation', 'delete_sample_category_record'),
        }.items():
            implementation = importlib.import_module('server_modules.mutations.' + module)
            for name in names:
                self.assertIs(getattr(mutation_services, name), getattr(implementation, name))
        self.assertIsInstance(server._mutation_service_context(), mutation_services.MutationServiceContext)

    def test_all_extracted_functions_resolve_global_dependencies(self):
        def check_code(code, namespace):
            for instruction in dis.get_instructions(code):
                if instruction.opname in {'LOAD_GLOBAL', 'LOAD_NAME'}:
                    self.assertTrue(instruction.argval in namespace or hasattr(builtins, instruction.argval),
                                    f'{code.co_filename}:{code.co_name}: missing {instruction.argval}')
            for constant in code.co_consts:
                if isinstance(constant, types.CodeType):
                    check_code(constant, namespace)

        for name in ('common', 'sample_guards', 'task_guards', 'effects', 'tasks', 'projects', 'samples'):
            module = importlib.import_module('server_modules.mutations.' + name)
            for value in vars(module).values():
                if inspect.isfunction(value) and value.__module__ == module.__name__:
                    check_code(value.__code__, vars(module))


if __name__ == '__main__':
    unittest.main()
