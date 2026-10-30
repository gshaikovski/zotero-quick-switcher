.PHONY: build test release

build:
	./build.sh

test:
	test/run.sh

# make release VERSION=X.Y.Z [NOTES=path/to/notes.md]
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=X.Y.Z [NOTES=file]"; exit 1; }
	./release.sh "$(VERSION)" $(NOTES)
