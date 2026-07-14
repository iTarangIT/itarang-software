"""
Static gate for agent-authored Python, applied BEFORE anything is executed.

The code we run here was written by an LLM about thirty seconds ago in response
to a prompt. The runtime is sandboxed (separate process, no network, resource
caps), but defence in depth means we also refuse to *start* code that has no
business running: imports, file access, attribute escapes into `__globals__`,
`eval`/`exec`, and so on.

This is an allowlist, not a blocklist. Anything the AST walk does not explicitly
permit is rejected. That means a legitimate hypothesis using an exotic construct
will occasionally be refused — which surfaces as an honest `inconclusive` card,
not as a wrong verdict, and is the trade we want.
"""

from __future__ import annotations

import ast

# The only names the code may reference beyond what it defines itself. `pd` and
# `np` are injected by the worker; there is no import statement anywhere.
ALLOWED_NAMES = {
    "pd",
    "np",
    "evaluate",
    "loans",
    "vehicle_states",
    "daily_km",
    # Safe builtins the worker re-exposes.
    "len", "range", "min", "max", "abs", "round", "sum", "sorted", "enumerate", "zip",
    "int", "float", "str", "bool", "list", "dict", "set", "tuple",
    "True", "False", "None",
}

# Node types that have no legitimate use in an evaluate() function and are the
# usual escape hatches out of a restricted namespace.
FORBIDDEN_NODES = (
    ast.Import,
    ast.ImportFrom,
    ast.Global,
    ast.Nonlocal,
    ast.Lambda,          # not needed, and a convenient hiding place
    ast.ClassDef,
    ast.AsyncFunctionDef,
    ast.Await,
    ast.Yield,
    ast.YieldFrom,
)

FORBIDDEN_CALLS = {
    "eval", "exec", "compile", "open", "input", "__import__",
    "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr",
    "breakpoint", "exit", "quit", "help", "memoryview", "id",
}


class ValidationError(Exception):
    """The code is refused. The message is shown to operators on the card."""


def validate(code: str) -> None:
    """Raise ValidationError if `code` is anything other than a plain evaluate()."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise ValidationError(f"syntax error: {e.msg} (line {e.lineno})") from e

    # Must define exactly the entrypoint we're going to call, and nothing else
    # at module level. A module-level side effect runs at exec() time, before we
    # ever call evaluate() — that is the first place hostile code would hide.
    toplevel = [n for n in tree.body if not isinstance(n, ast.FunctionDef)]
    if toplevel:
        raise ValidationError(
            "only a single `def evaluate(...)` is allowed at module level; "
            f"found {type(toplevel[0]).__name__} at line {toplevel[0].lineno}"
        )
    funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    if not any(f.name == "evaluate" for f in funcs):
        raise ValidationError("code does not define `def evaluate(loans, vehicle_states, daily_km)`")

    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN_NODES):
            raise ValidationError(
                f"{type(node).__name__} is not allowed (line {getattr(node, 'lineno', '?')}); "
                "only pandas (pd) and numpy (np) are available, already imported"
            )

        # Dunder attribute access is how you climb out of a restricted globals
        # dict: (1).__class__.__bases__[0].__subclasses__() and friends.
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValidationError(f"attribute `{node.attr}` is not allowed (line {node.lineno})")

        if isinstance(node, ast.Name):
            if node.id.startswith("__"):
                raise ValidationError(f"name `{node.id}` is not allowed (line {node.lineno})")
            # Reads of names we never provided. Assignments (Store) are the code's
            # own locals and are fine.
            if isinstance(node.ctx, ast.Load) and node.id not in ALLOWED_NAMES:
                if not _is_locally_bound(tree, node.id):
                    raise ValidationError(
                        f"unknown name `{node.id}` (line {node.lineno}); "
                        "only pd, np and the three DataFrames are in scope"
                    )

        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_CALLS:
                raise ValidationError(f"call to `{node.func.id}()` is not allowed (line {node.lineno})")


def _is_locally_bound(tree: ast.AST, name: str) -> bool:
    """True if the code assigns `name` itself (a local, a loop var, an arg)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id == name:
            return True
        if isinstance(node, ast.arg) and node.arg == name:
            return True
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return True
        if isinstance(node, (ast.comprehension,)) and isinstance(node.target, ast.Name) and node.target.id == name:
            return True
    return False
