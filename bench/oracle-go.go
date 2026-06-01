// Ground-truth oracle for Go, using the Go type checker (go/packages +
// go/types). For each func/method definition, emit the files containing a call
// that resolves (type-aware) to it. This is the same engine gopls uses.
//
// Setup (needs network once for golang.org/x/tools):
//   mkdir /tmp/go-oracle && cd /tmp/go-oracle && cp .../bench/oracle-go.go main.go
//   go mod init oracle && go get golang.org/x/tools/go/packages@latest
//   go run main.go <repo-dir> > oracle.json
// Then: node bench/accuracy-generic.mjs <repo-dir> oracle.json

package main

import (
	"encoding/json"
	"go/ast"
	"os"
	"path/filepath"
	"sort"

	"go/types"

	"golang.org/x/tools/go/packages"
)

type Def struct {
	Name        string   `json:"name"`
	CallerFiles []string `json:"callerFiles"`
}

func main() {
	root, _ := filepath.Abs(os.Args[1])
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedSyntax | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedFiles,
		Dir: root,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		panic(err)
	}
	rel := func(p string) string { r, _ := filepath.Rel(root, p); return r }

	// Collect function/method definition objects.
	defObjs := map[types.Object]string{}
	var fset = pkgs[0].Fset
	for _, p := range pkgs {
		if p.TypesInfo == nil {
			continue
		}
		for _, f := range p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				if fd, ok := n.(*ast.FuncDecl); ok && fd.Name != nil {
					if obj := p.TypesInfo.Defs[fd.Name]; obj != nil {
						defObjs[obj] = fd.Name.Name
					}
				}
				return true
			})
		}
	}

	// For each def, the set of files containing a call resolving to it.
	callers := map[string]map[string]bool{}
	record := func(name, file string) {
		if callers[name] == nil {
			callers[name] = map[string]bool{}
		}
		callers[name][rel(file)] = true
	}
	for _, p := range pkgs {
		if p.TypesInfo == nil {
			continue
		}
		for _, f := range p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				var id *ast.Ident
				switch fn := call.Fun.(type) {
				case *ast.Ident:
					id = fn
				case *ast.SelectorExpr:
					id = fn.Sel
				}
				if id == nil {
					return true
				}
				if obj := p.TypesInfo.Uses[id]; obj != nil {
					if name, isDef := defObjs[obj]; isDef {
						record(name, fset.Position(call.Pos()).Filename)
					}
				}
				return true
			})
		}
	}

	out := []Def{}
	for name, files := range callers {
		fs := []string{}
		for f := range files {
			fs = append(fs, f)
		}
		sort.Strings(fs)
		out = append(out, Def{Name: name, CallerFiles: fs})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(out)
}
