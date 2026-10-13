FROM gcr.io/oss-fuzz-base/base-builder-javascript
COPY . $SRC/mongodb-model
WORKDIR $SRC/mongodb-model
COPY .clusterfuzzlite/build.sh $SRC/build.sh
